const { cursorTo, eraseDown } = require('ansi-escapes').default;
const chalk = require('chalk').default;
const { get } = require('./telemetry');
const { get: getParser } = require('./parser');
const { getCtxSize } = require('./parser');

function toGB(mb) {
  return (mb / 1024).toFixed(1);
}

const BLOCKS = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

function sparkline(data, width = 30) {
  if (!data.length) return chalk.dim('\u2591'.repeat(width));
  const max = Math.max(...data, 1);
  return data.slice(-width).map(v => BLOCKS[Math.min(Math.floor((v / max) * 8), 8)]).join('');
}

function bar(value, max, width = 20) {
  if (!max || max <= 0) return chalk.grey('\u2591'.repeat(width));
  const pct = Math.max(0, Math.min(1, (value || 0) / max));
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const color = pct > 0.9 ? chalk.red : pct > 0.7 ? chalk.yellow : chalk.green;
  return color('\u2588'.repeat(filled)) + chalk.grey('\u2591'.repeat(empty));
}

function sparklinePct(data, max, width = 30) {
  if (!data.length || !max) return chalk.dim('\u2591'.repeat(width));
  return data.slice(-width).map(v => {
    const p = Math.max(0, Math.min(1, (v || 0) / max));
    return p > 0.5 ? '\u2588' : p > 0 ? '\u2591' : ' ';
  }).join('');
}

function fmt(val, suffix = '', decimals = 0) {
  if (val == null) return '--';
  return `${typeof val === 'number' ? Number(val.toFixed(decimals)) : val}${suffix}`;
}

function throttleBadges(reasons) {
  if (!reasons || !reasons.length) return '';
  const labels = {
    hw_thermal_slowdown: 'THERM',
    sw_thermal_slowdown: 'SW-THERM',
    sw_power_cap: 'POWER',
    hw_power_brake_slowdown: 'PWR-BRAKE'
  };
  const badges = reasons.map(r => chalk.red.bgWhite(` ${labels[r] || r} `)).join(' ');
  return ' ' + badges;
}

function renderGpuSection(lines, gpu, label, color, bufPrefix) {
  lines.push(color.bold(label));
  const pad = (str, len) => str + ' '.repeat(Math.max(0, len - str.length));
  lines.push(pad(chalk.dim('Name'), 12) + ` ${gpu.gpu_name || 'Unknown'}`);
  lines.push(pad(chalk.dim('Util'), 12) + ` ${fmt(gpu.gpu_util, '%')} ${bar(gpu.gpu_util, 100, 25)}`);
  const procVram = gpu.process_vram || 0;
  const otherVram = Math.max(0, (gpu.vram_used || 0) - procVram);
  lines.push(pad(chalk.dim('VRAM'), 12) + ` ${toGB(gpu.vram_used)} / ${toGB(gpu.vram_total)} GB (${fmt(gpu.vram_used * 100 / gpu.vram_total, '%', 0)}) ${bar(gpu.vram_used, gpu.vram_total, 25)}`);
  lines.push(pad(chalk.dim('Model'), 12) + ` ${toGB(procVram)} GB` + (otherVram > 0 ? ` | other ${toGB(otherVram)} GB` : ''));
  lines.push(pad(chalk.dim('Power'), 12) + ` ${fmt(gpu.gpu_pwr, 'W')} ${bar(gpu.gpu_pwr, 300, 25)}`);
  lines.push(pad(chalk.dim('Temp'), 12) + ` ${fmt(gpu.gpu_temp, '\u00B0C')} ${bar(gpu.gpu_temp, 90, 25)}` + throttleBadges(gpu.throttle_reasons));
  lines.push(pad(chalk.dim('Util Graph'), 12) + sparkline(bufPrefix === 'master' ? require('./telemetry').get().buffers.masterUtil : require('./telemetry').get().buffers.workerUtil, 30));
  lines.push(pad(chalk.dim('VRAM Graph'), 12) + sparklinePct(bufPrefix === 'master' ? require('./telemetry').get().buffers.masterVRAM : require('./telemetry').get().buffers.workerVRAM, gpu.vram_total, 30));
  lines.push('');
}

function render() {
  try {
    const { current, buffers } = get();
    const m = current.master;
    const w = current.worker;
    const width = process.stdout.columns || 80;
    const pad = (str, len) => str + ' '.repeat(Math.max(0, len - str.length));
    const sep = chalk.grey('\u2500'.repeat(Math.min(width - 2, 70)));

    const header = chalk.blue.bgWhite(' Llama CLI Monitor ');
    const lines = [header, sep];

    if (!m) {
      lines.push(chalk.dim('Waiting for monitor.py (port 8081)...'));
    } else {
      renderGpuSection(lines, m, 'GPU 1', chalk.blue, 'master');

      if (w && w.gpu_name && w.gpu_name !== 'Offline') {
        renderGpuSection(lines, w, 'GPU 2', chalk.yellow, 'worker');
      } else if (w) {
        lines.push(chalk.dim('GPU 2        Offline'));
        lines.push('');
      }

      const { buffers: tBufs, latest: tLatest } = getParser();
      lines.push(chalk.cyan.bold('TOKENS / CONTEXT'));
      lines.push(pad(chalk.dim('Prefill t/s'), 12) + ` ${fmt(tLatest.promptTps, ' t/s', 1)} ${sparkline(tBufs.promptTps, 20)}`);
      lines.push(pad(chalk.dim('Gen t/s'), 12) + ` ${fmt(tLatest.genTps, ' t/s', 1)} ${sparkline(tBufs.genTps, 20)}`);
      const ctxMax = getCtxSize();
      lines.push(pad(chalk.dim('Context'), 12) + ` ${tLatest.ctxUsed} / ${ctxMax ? ctxMax : '--'} tok ${ctxMax ? sparklinePct(tBufs.ctxUsed, ctxMax, 20) : ''}`);
      lines.push(pad(chalk.dim('Active'), 12) + ` ${tLatest.active ? chalk.green('generating') : chalk.dim('idle')}`);
      lines.push('');

      if (tLatest.completed.length > 0) {
        lines.push(chalk.cyan.bold('COMPLETED REQUESTS'));
        const recent = tLatest.completed.slice(-5).reverse();
        lines.push(pad('Prompt t/s', 12) + pad('Gen t/s', 10) + pad('P-tok', 8) + pad('G-tok', 8) + 'Wall ms');
        for (const r of recent) {
          lines.push(
            pad(fmt(r.promptTps, '', 0), 12) +
            pad(fmt(r.genTps, '', 0), 10) +
            pad(fmt(r.promptTokens, '', 0), 8) +
            pad(fmt(r.genTokens, '', 0), 8) +
            fmt(r.wallTimeMs, '', 0)
          );
        }
        lines.push('');
      }

      const netMbps = buffers.netMbps[buffers.netMbps.length - 1] || 0;
      lines.push(chalk.green.bold('NETWORK'));
      lines.push(pad(chalk.dim('Throughput'), 12) + ` ${netMbps.toFixed(1)} MB/s ${sparkline(buffers.netMbps, 30)}`);
      lines.push('');

      lines.push(chalk.magenta.bold('SYSTEM'));
      lines.push(pad(chalk.dim('CPU Util'), 12) + ` ${fmt(m.cpu_util, '%', 1)} ${bar(m.cpu_util, 100, 25)}`);
      lines.push(pad(chalk.dim('CPU Temp'), 12) + ` ${fmt(m.cpu_temp, '\u00B0C')}`);
      lines.push(pad(chalk.dim('RAM'), 12) + ` ${toGB(m.ram_used)} / ${toGB(m.ram_total)} GB ${bar(m.ram_used, m.ram_total, 25)}`);
    }

    lines.push('', sep, chalk.dim('q: Quit  |  k: Kill Server  |  r: Refresh  |  Ctrl+C: Quit'));

    process.stdout.write(cursorTo(0, 0) + eraseDown + lines.join('\n'));
  } catch (err) {
    // Silently swallow render errors so the loop stays alive
  }
}

function setupInput(onQuit, onKill) {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    return;
  }
  process.stdin.on('data', (key) => {
    const buf = Buffer.isBuffer(key) ? key[0] : 0;
    if (key === 'q' || buf === 113) onQuit();
    if (key === 'k' || buf === 107) onKill();
    if (key === 'r' || buf === 114) render();
    if (buf === 3) onQuit();
  });
}

function cleanup() {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch { /* ignore */ }
  try { process.stdin.pause(); } catch { /* ignore */ }
  try { process.stdout.write('\n'); } catch { /* ignore */ }
}

module.exports = { render, setupInput, cleanup };
