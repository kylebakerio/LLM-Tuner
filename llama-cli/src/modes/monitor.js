import React from 'react';
import { Box, Text } from 'ink';
import { Sparkline, SparkPct, Bar } from './sparkline.js';
import { KeymapBar } from './statusbar.js';
import { useAppStore } from '../state.js';
import { fmt, toGB, pad, pctColor, throttleBadges, portFromCommand } from '../format.js';

function GpuSection({ label, gpu, buffers, color }) {
  if (!gpu) return null;
  if (gpu.gpu_name === 'Offline') {
    return <Text dimColor>  {pad(label, 14)} offline</Text>;
  }
  const procVram = gpu.process_vram || 0;
  const otherVram = Math.max(0, (gpu.vram_used || 0) - procVram);
  const pwrMax = 350; // display ceiling; bars color on the 90%/70% rules anyway
  return (
    <Box flexDirection="column">
      <Text bold color={color}>{label} · {gpu.gpu_name}</Text>
      <Text>
        {pad('util', 12)} {fmt(gpu.gpu_util, '%', 0).padStart(4)}{' '}
        <Bar value={gpu.gpu_util} max={100} width={25} />
        {'  '}<Sparkline data={buffers.util} width={28} color={color} />
      </Text>
      <Text>
        {pad('vram', 12)} {toGB(gpu.vram_used)}/{toGB(gpu.vram_total)} GB{' '}
        {fmt((gpu.vram_used || 0) * 100 / (gpu.vram_total || 1), '%', 0).padStart(4)}{' '}
        <Bar value={gpu.vram_used} max={gpu.vram_total} width={25} />
        {'  '}<SparkPct data={buffers.vram} max={gpu.vram_total} width={28} color={color} />
      </Text>
      <Text>
        {pad('model', 12)} {toGB(procVram)} GB{otherVram > 0 ? ` · other ${toGB(otherVram)} GB` : ''}
      </Text>
      <Text>
        {pad('power', 12)} {fmt(gpu.gpu_pwr, 'W', 0).padStart(5)}{' '}
        <Bar value={gpu.gpu_pwr} max={pwrMax} width={25} />
        {'  '}<Text dimColor>temp {fmt(gpu.gpu_temp, '\u00B0C', 0)}</Text>
        {throttleBadges(gpu.throttle_reasons) ? (
          <Text color="red" bold>{throttleBadges(gpu.throttle_reasons)}</Text>
        ) : null}
      </Text>
    </Box>
  );
}

export function Monitor({ appStore, serverUrl }) {
  const s = useAppStore(appStore);
  const t = s.telemetry;
  const m = t && t.master;
  const w = t && t.worker;
  const port = portFromCommand(s.server.launchCommand);
  const now = Date.now();

  if (s.conn !== 'live') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" paddingX={2}>
        <Text color="red" bold>Mission Control offline</Text>
        <Text dimColor>can't reach the dashboard at {serverUrl}</Text>
        <Text dimColor>start it with:  pm2 start ecosystem.config.js  (from the dashboard directory)</Text>
        <Text dimColor>or point at another instance:  llama-cli --server http://host:3000</Text>
        <Text color="yellow">reconnecting automatically…</Text>
      </Box>
    );
  }

  const loading = s.server.state === 'starting' || s.server.state === 'loading';
  const elapsed = loading && s.server.loadStartTime
    ? fmt((now - s.server.loadStartTime) / 1000, 's', 0)
    : null;

  const recent = s.completions.slice(-6).reverse();

  return (
    <Box flexDirection="column">
      {s.server.error ? (
        <Box><Text color="red" bold> {s.server.error}</Text></Box>
      ) : null}

      {loading ? (
        <Box>
          <Text color="yellow" bold> loading model…</Text>
          {elapsed ? <Text dimColor> {elapsed} so far</Text> : null}
          <Text dimColor>  (VRAM/power ramp below is real signal)</Text>
        </Box>
      ) : s.server.state !== 'ready' ? (
        <Box>
          <Text dimColor> no model loaded — </Text>
          <Text color="cyan">press 2 to launch</Text>
        </Box>
      ) : (
        <Box>
          <Text dimColor> model on :{port}</Text>
          {s.live.active ? (
            <Text color="green"> · generating</Text>
          ) : (
            <Text dimColor> · idle</Text>
          )}
        </Box>
      )}
      <Text> </Text>

      {m ? (
        <GpuSection
          label="GPU 0"
          gpu={m}
          buffers={{ util: s.buffers.mUtil, vram: s.buffers.mVram }}
          color="blue"
        />
      ) : (
        <Text dimColor>  waiting for telemetry (monitor.py)...</Text>
      )}
      <Text> </Text>

      {w && w.gpu_name && w.gpu_name !== 'Offline' ? (
        <GpuSection
          label={s.server.isRpc ? 'GPU 1 (rpc)' : 'GPU 1'}
          gpu={w}
          buffers={{ util: s.buffers.wUtil, vram: s.buffers.wVram }}
          color="magenta"
        />
      ) : null}
      <Text> </Text>

      <Box flexDirection="column">
        <Text bold color="cyan">TOKENS / CONTEXT</Text>
        <Text>
          {pad('prefill', 12)} {fmt(s.live.promptTps, ' t/s', 1).padStart(9)}{' '}
          <Sparkline data={s.buffers.promptTps} width={20} color="cyan" />
        </Text>
        <Text>
          {pad('gen', 12)} {fmt(s.live.genTps, ' t/s', 1).padStart(9)}
          {s.live.genInst ? <Text dimColor> (inst {fmt(s.live.genInst, '', 1)})</Text> : null}{'  '}
          <Sparkline data={s.buffers.genTps} width={20} color="cyan" />
        </Text>
        <Text>
          {pad('context', 12)}
          {s.live.ctxTotal > 0
            ? ` ${s.live.ctxUsed.toLocaleString()} / ${s.live.ctxTotal.toLocaleString()} tok  `
              + <Bar value={s.live.ctxUsed} max={s.live.ctxTotal} width={20} />
            : <Text dimColor> --</Text>}
        </Text>
      </Box>
      <Text> </Text>

      {recent.length > 0 ? (
        <Box flexDirection="column">
          <Text bold color="cyan">COMPLETED REQUESTS</Text>
          <Text dimColor>
            {'  '}{pad('time', 9)}{pad('P t/s', 8)}{pad('G t/s', 8)}{pad('p-tok', 8)}{pad('g-tok', 8)}'wall'}
          </Text>
          {recent.map((r) => (
            <Text key={r.runId || r.time + r.wallTime}>
              {'  '}{pad(r.time, 9)}
              {pad(fmt(r.promptTps, '', 0), 8)}
              {pad(fmt(r.genTps, '', 0), 8)}
              {pad(fmt(r.promptTokens, '', 0), 8)}
              {pad(fmt(r.genTokens, '', 0), 8)}
              {fmt(r.wallTime, 's', 1)}
              {r.aborted ? <Text color="red">  ABORTED</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text> </Text>

      {m ? (
        <Box flexDirection="column">
          <Text bold color="green">SYSTEM</Text>
          <Text>
            {pad('cpu', 12)} {fmt(m.cpu_util, '%', 1).padStart(5)}{' '}
            <Bar value={m.cpu_util} max={100} width={25} />
            {'  '}<Text dimColor>temp {fmt(m.cpu_temp, '\u00B0C', 0)}</Text>
          </Text>
          <Text>
            {pad('ram', 12)} {toGB(m.ram_used)}/{toGB(m.ram_total)} GB{' '}
            <Bar value={m.ram_used} max={m.ram_total} width={25} />
          </Text>
          <Text>
            {pad('net', 12)} {s.netMbps.toFixed(2)} MB/s  <Sparkline data={s.buffers.net} width={28} color="green" />
          </Text>
        </Box>
      ) : null}
      <Text> </Text>

      {s.logTail.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>LOG</Text>
          {s.logTail.slice(-5).map((line, i) => (
            <Text key={i} dimColor>  {line.length > 100 ? line.slice(0, 100) + '…' : line}</Text>
          ))}
        </Box>
      ) : null}

      <KeymapBar hints={[
        ['x', 'stop server'], ['s', 'launch mode'], ['?', 'help'], ['q', 'quit TUI'],
      ]} />
    </Box>
  );
}
