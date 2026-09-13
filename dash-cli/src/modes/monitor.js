import { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { h } from '../h.js';
import { Sparkline, Bar } from '../components/sparkline.js';
import { KeymapBar } from '../components/statusbar.js';
import { useAppStore } from '../state.js';
import { fmt, toGB, pad, throttleBadges, portFromCommand, gpuOnline, gpuTitles } from '../format.js';

// Boxed section with the title embedded IN the top border line (btop-style):
// the Box draws left/right/bottom borders; the first child draws the top
// border with the title spliced in. `width` is the OUTER width (borders
// included); children must fit within width-2 columns.
function Section({ title, color, width, children }) {
  const inner = width - 2;
  const label = `\u2500[ ${title} ]`;
  const fill = Math.max(0, inner - label.length - 2);
  return h(Box, { borderStyle: 'round', borderTop: false, borderColor: color, width, flexDirection: 'column' },
    h(Text, { color }, `\u256d${label}${'\u2500'.repeat(fill)}\u256e`),
    children,
  );
}

// Splits the space after the label+value text between a bar and a trailing
// braille sparkline (bar gets the larger share; the sparkline is dropped if
// the row is too narrow for a readable one).
function fitBar(inner, prefixLen) {
  const rest = Math.max(0, inner - prefixLen - 1);
  if (rest < 16) return { barW: rest, sparkW: 0 };
  const barW = Math.max(8, Math.floor((rest - 10) * 0.55));
  const sparkW = Math.max(0, rest - barW - 1);
  return { barW, sparkW: sparkW < 6 ? 0 : sparkW };
}

// FIXED 4-LINE HEIGHT (util/vram/pow/throttle) in every state -- including
// offline/waiting -- so a badge appearing or telemetry dropping can never
// change the box height and push the panels below it (layout thrash).
// Vendor-neutral: the master may be the AMD card (amdgpu_top) and the worker
// the NVIDIA one (nvidia-smi); gpuOnline checks both error flags.
function GpuBox({ title, gpu, buffers, width, color }) {
  const inner = width - 2;
  const up = gpuOnline(gpu);
  const g = up ? gpu : null;
  const offline = !up && !!gpu; // monitor.py says the card is offline / its query failed
  const name = g ? (g.gpu_name || 'GPU').replace(/^NVIDIA GeForce /, '').replace(/^AMD /, '') : null;
  const procVram = g ? g.process_vram || 0 : 0;
  const otherVram = g ? Math.max(0, (g.vram_used || 0) - procVram) : 0;
  // Power bars auto-scale to the session max (floor 100W): a laptop 4090
  // is capped well under the 350W of a desktop card, so a fixed max left
  // the bar a sliver even under load.
  const pwrMax = g ? Math.max(100, ...(buffers.pwr || [0])) : 100;
  // '  throttle: ' prefix is 12 columns; leave that much out of the badge budget.
  const badges = g ? throttleBadges(g, inner - 12) : { segments: [] };

  const utilVal = g ? fmt(g.gpu_util, '%', 0).padStart(4) : '--';
  const u = fitBar(inner, 1 + 4 + 1 + utilVal.length + 1);
  const vramVal = g ? `${toGB(g.vram_used)}/${toGB(g.vram_total)}` : '--/--';
  const v = fitBar(inner, 1 + 4 + 1 + vramVal.length + 1);
  const pwrVal = g ? fmt(g.gpu_pwr, 'W', 0).padStart(4) : '--';
  const trail = g
    ? ` ${fmt(g.gpu_temp, '\u00B0C', 0)} \u00B7 m ${toGB(procVram)}G` + (otherVram > 0 ? ` \u00B7 o ${toGB(otherVram)}G` : '')
    : ` ${offline ? 'offline' : 'waiting for telemetry...'}`;
  const p = fitBar(inner, 1 + 4 + 1 + pwrVal.length + 1 + trail.length);

  return h(Section, { title: `${title}${name ? ` \u00B7 ${name}` : ''}`, color, width },
    h(Text, { dimColor: !up },
      ` ${pad('util', 4)} ${utilVal} `,
      g ? h(Bar, { value: g.gpu_util, max: 100, width: u.barW }) : null,
      // NOTE: the sparkline goes in its own Text -- a component element
      // string-concatenated into a sibling (' ' + h(...)) becomes
      // "[object Object]" in the rendered output.
      g && u.sparkW ? h(Text, null, ' ', h(Sparkline, { data: buffers.util, width: u.sparkW, color })) : null,
    ),
    h(Text, { dimColor: !up },
      ` ${pad('vram', 4)} ${vramVal} `,
      g ? h(Bar, { value: g.vram_used, max: g.vram_total, width: v.barW }) : null,
      g && v.sparkW ? h(Text, null, ' ', h(Sparkline, { data: buffers.vram, max: g.vram_total, width: v.sparkW, color })) : null,
    ),
    h(Text, { dimColor: !up },
      ` ${pad('pow', 4)} ${pwrVal} `,
      g ? h(Bar, { value: g.gpu_pwr, max: pwrMax, width: p.barW }) : null,
      h(Text, { dimColor: true }, trail),
    ),
    h(Text, null,
      '  ',
      h(Text, { dimColor: true }, 'throttle: '),
      badges.segments.length > 0
        ? badges.segments.map((b, i) => h(Text, {
          key: i,
          color: b.level === 'real' ? 'red' : b.level === 'warn' ? 'yellow' : undefined,
          bold: b.level === 'real',
          dimColor: b.level === 'info',
        }, b.label))
        : h(Text, { dimColor: true }, 'none'),
    ),
  );
}

// "avg(lo\u2013hi)" from the server-computed per-request range (COMPLETION's
// prefillTpsMin/Max, genTpsMin/Max); older rows carry no range.
function tpsCell(avg, lo, hi) {
  if (avg == null || !Number.isFinite(Number(avg))) return '--';
  const a = fmt(avg, '', 0);
  if (lo != null && hi != null && Number.isFinite(Number(lo)) && Number.isFinite(Number(hi)) && Number(hi) > Number(lo)) {
    return `${a}(${fmt(lo, '', 0)}\u2013${fmt(hi, '', 0)})`;
  }
  return a;
}

export function Monitor({ appStore, client, serverUrl, modeGateRef, onLaunchMode }) {
  const { stdout } = useStdout();
  const cols = (stdout && stdout.columns) || 80;
  const s = useAppStore(appStore);
  const t = s.telemetry;
  const m = t && t.master;
  const w = t && t.worker;
  const port = portFromCommand(s.server.launchCommand);
  const now = Date.now();
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopErr, setStopErr] = useState(null);

  // A transient "Stop requested" line would linger forever; success is
  // visible in the [state] column of the status bar, so only failures
  // get a message.
  useEffect(() => {
    if (s.server.state === 'stopped') setStopErr(null);
  }, [s.server.state]);

  modeGateRef.current = confirmStop;

  useInput((input, key) => {
    if (confirmStop) {
      if (key.escape || input === 'n' || input === 'q') setConfirmStop(false);
      else if (input === 'y') {
        setConfirmStop(false);
        client.postJson('/api/stop')
          .catch((err) => setStopErr(`Stop failed: ${err.message}`));
      }
      return;
    }
    if (input === 's' && !key.ctrl) onLaunchMode();
    else if (input === 'x' && !key.ctrl
      && ['ready', 'starting', 'loading'].includes(s.server.state)) setConfirmStop(true);
  });

  if (s.conn !== 'live') {
    return h(Box, { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingX: 2 },
      h(Text, { color: 'red', bold: true }, 'Mission Control offline'),
      h(Text, { dimColor: true }, `can't reach the dashboard at ${serverUrl}`),
      h(Text, { dimColor: true }, 'start it with:  pm2 start ecosystem.config.js  (from the dashboard directory)'),
      h(Text, { dimColor: true }, 'or point at another instance:  llama-cli --server http://host:3000'),
      h(Text, { color: 'yellow' }, 'reconnecting automatically\u2026'),
    );
  }

  const loading = s.server.state === 'starting' || s.server.state === 'loading';
  const elapsed = loading && s.server.loadStartTime
    ? fmt((now - s.server.loadStartTime) / 1000, 's', 0)
    : null;

  const recent = s.completions.slice(-3).reverse();

  const stateLine = loading
    ? h(Text, null,
      h(Spinner, { type: 'dots', color: 'yellow' }),
      h(Text, { color: 'yellow', bold: true }, ' loading model'),
      elapsed ? h(Text, { dimColor: true }, ` ${elapsed} so far`) : null,
      h(Text, { dimColor: true }, '  (the VRAM/power ramp below is real signal)'),
    )
    : s.server.state !== 'ready'
      ? h(Text, null,
        h(Text, { dimColor: true }, ' no model loaded \u2014 '),
        h(Text, { color: 'cyan' }, 'press 2 to launch'),
      )
      : h(Text, null,
        h(Text, { dimColor: true }, ` model on :${port}`),
        s.live.active
          ? h(Text, { color: 'green' }, ' \u00B7 generating')
          : h(Text, { dimColor: true }, ' \u00B7 idle'),
      );

  // Panel widths: two boxes per row, one column gap.
  const half1 = Math.max(34, Math.floor((cols - 1) / 2));
  const half2 = Math.max(30, cols - 1 - half1);

  // ---- TOKENS / CONTEXT panel ----
  const tokensInner = half1 - 2;
  const t1 = fitBar(tokensInner, 1 + 4 + 1 + 7);
  const t2 = fitBar(tokensInner, 1 + 4 + 1 + 7);
  const ctxUsedTxt = s.live.ctxTotal > 0 ? `${Math.round(s.live.ctxUsed / 1000)}k/${Math.round(s.live.ctxTotal / 1000)}k` : '';
  const t3 = fitBar(tokensInner, 1 + 4 + 1 + Math.max(ctxUsedTxt.length, 4) + 1);
  const tokensBox = h(Section, { title: 'TOKENS / CONTEXT', color: 'cyan', width: half1 },
    h(Text, null,
      ` ${pad('pre', 4)} ${fmt(s.live.promptTps, '', 1).padStart(7)} `,
      h(Sparkline, { data: s.buffers.promptTps, width: t1.sparkW || t1.barW, color: 'cyan' }),
    ),
    h(Text, null,
      ` ${pad('gen', 4)} ${fmt(s.live.genTps, '', 1).padStart(7)}`,
      s.live.genInst ? h(Text, { dimColor: true }, `(${fmt(s.live.genInst, '', 0)})`) : null,
      ' ',
      h(Sparkline, { data: s.buffers.genTps, width: t2.sparkW || t2.barW, color: 'cyan' }),
    ),
    h(Text, null,
      ` ${pad('ctx', 4)} ${ctxUsedTxt || '    '} `,
      s.live.ctxTotal > 0
        ? h(Bar, { value: s.live.ctxUsed, max: s.live.ctxTotal, width: t3.barW })
        : h(Text, { dimColor: true }, '--'),
    ),
  );

  // ---- COMPLETED panel (half-width: time, prefill, gen, wall -- ranges from
  // the server-computed per-request min/max). Columns sum to EXACTLY the
  // inner width (no leading space): any overflow wraps the wall column onto
  // its own line. FIXED HEADER + 3 ROWS so the panel never changes height
  // when the first request lands or the table drains.
  const cInner = half2 - 2;
  const cTime = 8, cWall = 6;
  const cRest = Math.max(12, cInner - cTime - cWall);
  const cP = Math.ceil(cRest / 2);
  const cG = cRest - cP;
  // A range cell ("245(230–260)") can be wider than its column on narrow
  // terminals -- clip rather than wrap the row. Numbers right-align (btop
  // style) so the decimal points line up across rows.
  const cell = (s, w) => (s.length > w ? s.slice(0, w) : s);
  const ra = (s, w) => (s.length >= w ? s : ' '.repeat(w - s.length) + s);
  const completedRows = [];
  for (let i = 0; i < 3; i++) {
    const r = recent[i];
    if (!r) {
      // A space, not '': ink collapses an empty Text to zero height, which
      // would shrink the panel (layout thrash).
      completedRows.push(h(Text, { key: `pad-${i}`, dimColor: true },
        i === 0 && recent.length === 0 ? '  (none yet this session)' : ' '));
      continue;
    }
    // ABORTED rows reserve the suffix inside the row budget (shrinking the
    // P/G cells) so the row can never wrap onto an extra line.
    const suffix = r.aborted ? ' ABORTED' : '';
    const rest = cRest - suffix.length;
    const pW = Math.max(4, Math.ceil(rest / 2));
    const gW = Math.max(4, rest - pW);
    const p = cell(tpsCell(r.promptTps, r.prefillTpsMin, r.prefillTpsMax), pW);
    const g = cell(tpsCell(r.genTps, r.genTpsMin, r.genTpsMax), gW);
    const wall = cell(fmt(r.wallTime, 's', r.wallTime >= 10 ? 0 : 1), cWall);
    completedRows.push(h(Text, { key: r.runId || `${r.time}-${r.wallTime}` },
      `${ra(r.time, cTime)}${ra(p, pW)}${ra(g, gW)}${ra(wall, cWall)}`,
      r.aborted ? h(Text, { color: 'red' }, suffix) : null,
    ));
  }
  const completedBox = h(Section, { title: 'COMPLETED REQUESTS', color: 'yellow', width: half2 },
    h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true },
        `${pad('time', cTime)}${pad(cell('P t/s', cP), cP)}${pad(cell('G t/s', cG), cG)}wall`),
      ...completedRows,
    ),
  );

  // ---- SYSTEM panel (fixed 4 lines: local cpu, local ram, worker, net;
  // dim placeholders before the first telemetry sample / with no worker so
  // the panel height never changes) ----
  const sInner = half1 - 2;
  // The worker row is the RPC laptop's own CPU/RAM (separate host). The
  // offline fallback dict says cpu_name 'Offline' and ram_total 1.
  const wSys = !!(w && w.cpu_name !== 'Offline' && Number(w.ram_total) > 1);
  const wText = wSys
    ? `${fmt(w.cpu_util, '%', 0).padStart(4)} ${fmt(w.cpu_temp, '°C', 0)} · ram ${toGB(w.ram_used)}/${toGB(w.ram_total)}G `
    : (s.server.isRpc ? 'worker telemetry offline' : '(no rpc worker)');
  const syW = fitBar(sInner, 1 + 4 + 1 + wText.length);
  const cpuTrail = m ? ` ${fmt(m.cpu_temp, '\u00B0C', 0)}` : '';
  const sy1 = fitBar(sInner, 1 + 4 + 1 + 6 + 1 + Math.max(cpuTrail.length, ' no telemetry yet'.length));
  const ramVal = m ? `${toGB(m.ram_used)}/${toGB(m.ram_total)}` : '';
  const sy2 = fitBar(sInner, 1 + 4 + 1 + Math.max(ramVal.length, 7) + 1);
  const sy3 = fitBar(sInner, 1 + 4 + 1 + 9 + 1);
  const systemBox = h(Section, { title: 'SYSTEM', color: 'green', width: half1 },
    h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: !m },
        ` ${pad('cpu', 4)} ${m ? fmt(m.cpu_util, '%', 1).padStart(6) : '  --'} `,
        m ? h(Bar, { value: m.cpu_util, max: 100, width: sy1.barW }) : null,
        h(Text, { dimColor: true }, m ? cpuTrail : ' no telemetry yet'),
      ),
      h(Text, { dimColor: !m },
        ` ${pad('ram', 4)} ${ramVal || '    --'} `,
        m ? h(Bar, { value: m.ram_used, max: m.ram_total, width: sy2.barW }) : null,
      ),
      h(Text, { dimColor: !wSys },
        ` ${pad('wrk', 4)} `,
        h(Text, { color: wSys ? 'magenta' : undefined }, wText),
        wSys ? h(Bar, { value: w.ram_used, max: w.ram_total, width: Math.max(0, syW.barW) }) : null,
      ),
      h(Text, null,
        ` ${pad('net', 4)} ${s.netMbps.toFixed(2)} MB/s `,
        h(Sparkline, { data: s.buffers.net, width: sy3.sparkW || sy3.barW, color: 'green' }),
      ),
    ),
  );

  // ---- LOG panel (fixed 4 lines, matching SYSTEM; dim padding keeps the
  // height constant) ----
  const lInner = half2 - 2;
  const logLines = s.logTail.slice(-4);
  const logBox = h(Section, { title: 'LOG', color: 'gray', width: half2 },
    h(Box, { flexDirection: 'column' },
      [0, 1, 2, 3].map((i) => {
        const line = logLines[i];
        const max = Math.max(10, lInner - 2);
        return h(Text, { key: i, dimColor: true },
          line == null
            ? (i === 0 && logLines.length === 0 ? '  (quiet)' : ' ')
            : `  ${line.length > max ? line.slice(0, max - 1) + '\u2026' : line}`);
      }),
    ),
  );

  // One PERMANENT status line under the state line (stop failure > server
  // error > stop-confirm > blank) so a message appearing or clearing never
  // changes the screen height and shifts the panels (layout thrash).
  let statusLine;
  if (stopErr) {
    statusLine = h(Text, { color: 'red' }, ` ${stopErr}`);
  } else if (s.server.error) {
    const err = s.server.error.length > cols - 1
      ? s.server.error.slice(0, cols - 2) + '\u2026'
      : s.server.error;
    statusLine = h(Text, { color: 'red', bold: true }, ` ${err}`);
  } else if (confirmStop) {
    statusLine = h(Box, null,
      h(Text, { color: 'yellow' }, ' Stop the model server? '),
      h(Text, { bold: true }, '[y/N]'),
    );
  } else {
    statusLine = h(Text, null, ' ');
  }

  return h(Box, { flexDirection: 'column' },
    stateLine,
    statusLine,

    // During an RPC run the worker panel stays up even when its telemetry
    // drops (shown as offline) -- a vanishing panel would hide exactly the
    // failure worth seeing.
    h(Box, { flexDirection: 'row' },
      h(GpuBox, { title: gpuTitles(s.server.isRpc)[0], gpu: m, buffers: { util: s.buffers.mUtil, vram: s.buffers.mVram, pwr: s.buffers.mPwr }, width: half1, color: 'blue' }),
      gpuOnline(w) || s.server.isRpc
        ? h(GpuBox, { title: gpuTitles(s.server.isRpc)[1], gpu: w, buffers: { util: s.buffers.wUtil, vram: s.buffers.wVram, pwr: s.buffers.wPwr }, width: half2, color: 'magenta' })
        : null,
    ),
    h(Box, { flexDirection: 'row' },
      tokensBox,
      completedBox,
    ),
    h(Box, { flexDirection: 'row' },
      systemBox,
      logBox,
    ),

    h(KeymapBar, { hints: [['x', 'stop server'], ['s', 'launch mode'], ['?', 'help'], ['q', 'quit TUI']] }),
  );
}
