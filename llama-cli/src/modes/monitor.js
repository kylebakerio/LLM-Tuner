import { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { h } from '../h.js';
import { Sparkline, Bar } from '../components/sparkline.js';
import { KeymapBar } from '../components/statusbar.js';
import { useAppStore } from '../state.js';
import { fmt, toGB, pad, throttleBadges, portFromCommand } from '../format.js';

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

function GpuBox({ idx, gpu, buffers, width, color, tag }) {
  const inner = width - 2;
  if (!gpu || gpu.gpu_name === 'Offline') {
    return h(Section, { title: `GPU ${idx}${tag ? ` ${tag}` : ''}`, color, width },
      h(Text, { dimColor: true }, gpu ? '  offline' : '  waiting for telemetry (monitor.py)...'),
    );
  }
  const name = (gpu.gpu_name || 'GPU').replace(/^NVIDIA GeForce /, '').replace(/^AMD /, '');
  const procVram = gpu.process_vram || 0;
  const otherVram = Math.max(0, (gpu.vram_used || 0) - procVram);
  // Power bars auto-scale to the session max (floor 100W): a laptop 4090
  // is capped well under the 350W of a desktop card, so a fixed max left
  // the bar a sliver even under load.
  const pwrMax = Math.max(100, ...(buffers.pwr || [0]));
  const badges = throttleBadges(gpu.throttle_reasons);

  const utilVal = `${fmt(gpu.gpu_util, '%', 0).padStart(4)}`;
  const u = fitBar(inner, 1 + 4 + 1 + utilVal.length + 1);
  const vramVal = `${toGB(gpu.vram_used)}/${toGB(gpu.vram_total)}`;
  const v = fitBar(inner, 1 + 4 + 1 + vramVal.length + 1);
  const pwrVal = `${fmt(gpu.gpu_pwr, 'W', 0).padStart(4)}`;
  const trail = ` ${fmt(gpu.gpu_temp, '\u00B0C', 0)} \u00B7 m ${toGB(procVram)}G` + (otherVram > 0 ? ` \u00B7 o ${toGB(otherVram)}G` : '');
  const p = fitBar(inner, 1 + 4 + 1 + pwrVal.length + 1 + trail.length);

  return h(Section, { title: `GPU ${idx}${tag ? ` ${tag}` : ''} \u00B7 ${name}`, color, width },
    h(Text, null,
      ` ${pad('util', 4)} ${utilVal} `,
      h(Bar, { value: gpu.gpu_util, max: 100, width: u.barW }),
      // NOTE: the sparkline goes in its own Text -- a component element
      // string-concatenated into a sibling (' ' + h(...)) becomes
      // "[object Object]" in the rendered output.
      u.sparkW ? h(Text, null, ' ', h(Sparkline, { data: buffers.util, width: u.sparkW, color })) : null,
    ),
    h(Text, null,
      ` ${pad('vram', 4)} ${vramVal} `,
      h(Bar, { value: gpu.vram_used, max: gpu.vram_total, width: v.barW }),
      v.sparkW ? h(Text, null, ' ', h(Sparkline, { data: buffers.vram, max: gpu.vram_total, width: v.sparkW, color })) : null,
    ),
    h(Text, null,
      ` ${pad('pow', 4)} ${pwrVal} `,
      h(Bar, { value: gpu.gpu_pwr, max: pwrMax, width: p.barW }),
      h(Text, { dimColor: true }, trail),
    ),
    badges ? h(Text, { color: 'red', bold: true }, `  throttle: ${badges}`) : null,
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
  // its own line.
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
  const completedBox = h(Section, { title: 'COMPLETED REQUESTS', color: 'yellow', width: half2 },
    recent.length > 0
      ? h(Box, { flexDirection: 'column' },
          h(Text, { dimColor: true },
            `${pad('time', cTime)}${pad(cell('P t/s', cP), cP)}${pad(cell('G t/s', cG), cG)}wall`),
          recent.map((r) => {
            const p = cell(tpsCell(r.promptTps, r.prefillTpsMin, r.prefillTpsMax), cP);
            const g = cell(tpsCell(r.genTps, r.genTpsMin, r.genTpsMax), cG);
            const wall = cell(fmt(r.wallTime, 's', r.wallTime >= 10 ? 0 : 1), cWall);
            return h(Text, { key: r.runId || `${r.time}-${r.wallTime}` },
              `${ra(r.time, cTime)}${ra(p, cP)}${ra(g, cG)}${ra(wall, cWall)}`,
              r.aborted ? h(Text, { color: 'red' }, ' ABORTED') : null,
            );
          }),
        )
      : h(Text, { dimColor: true }, '  (none yet this session)'),
  );

  // ---- SYSTEM panel ----
  const sInner = half1 - 2;
  const cpuTrail = m ? ` ${fmt(m.cpu_temp, '\u00B0C', 0)}` : '';
  const sy1 = fitBar(sInner, 1 + 4 + 1 + 6 + 1 + cpuTrail.length);
  const ramVal = m ? `${toGB(m.ram_used)}/${toGB(m.ram_total)}` : '';
  const sy2 = fitBar(sInner, 1 + 4 + 1 + Math.max(ramVal.length, 7) + 1);
  const sy3 = fitBar(sInner, 1 + 4 + 1 + 9 + 1);
  const systemBox = h(Section, { title: 'SYSTEM', color: 'green', width: half1 },
    m
      ? h(Box, { flexDirection: 'column' },
          h(Text, null,
            ` ${pad('cpu', 4)} ${fmt(m.cpu_util, '%', 1).padStart(6)} `,
            h(Bar, { value: m.cpu_util, max: 100, width: sy1.barW }),
            h(Text, { dimColor: true }, cpuTrail),
          ),
          h(Text, null,
            ` ${pad('ram', 4)} ${ramVal} `,
            h(Bar, { value: m.ram_used, max: m.ram_total, width: sy2.barW }),
          ),
          h(Text, null,
            ` ${pad('net', 4)} ${s.netMbps.toFixed(2)} MB/s `,
            h(Sparkline, { data: s.buffers.net, width: sy3.sparkW || sy3.barW, color: 'green' }),
          ),
        )
      : h(Text, { dimColor: true }, '  waiting for telemetry...'),
  );

  // ---- LOG panel ----
  const lInner = half2 - 2;
  const logBox = h(Section, { title: 'LOG', color: 'gray', width: half2 },
    s.logTail.length > 0
      ? h(Box, { flexDirection: 'column' },
          s.logTail.slice(-3).map((line, i) => {
            const max = Math.max(10, lInner - 2);
            return h(Text, { key: i, dimColor: true },
              `  ${line.length > max ? line.slice(0, max - 1) + '\u2026' : line}`);
          }),
        )
      : h(Text, { dimColor: true }, '  (quiet)'),
  );

  return h(Box, { flexDirection: 'column' },
    s.server.error
      ? h(Box, null, h(Text, { color: 'red', bold: true }, ` ${s.server.error}`))
      : null,
    stateLine,
    confirmStop
      ? h(Box, null,
        h(Text, { color: 'yellow' }, ' Stop the model server? '),
        h(Text, { bold: true }, '[y/N]'),
      )
      : null,
    stopErr ? h(Box, null, h(Text, { color: 'red' }, ` ${stopErr}`)) : null,

    h(Box, { flexDirection: 'row' },
      h(GpuBox, { idx: 0, gpu: m, buffers: { util: s.buffers.mUtil, vram: s.buffers.mVram, pwr: s.buffers.mPwr }, width: half1, color: 'blue' }),
      w && w.gpu_name && w.gpu_name !== 'Offline'
        ? h(GpuBox, { idx: 1, tag: s.server.isRpc ? '(rpc)' : null, gpu: w, buffers: { util: s.buffers.wUtil, vram: s.buffers.wVram, pwr: s.buffers.wPwr }, width: half2, color: 'magenta' })
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
