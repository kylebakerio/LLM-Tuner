export const BLOCKS = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

export function fmt(val, suffix = '', decimals = 0) {
  if (val == null || (typeof val === 'number' && !Number.isFinite(val))) return '--';
  const n = typeof val === 'number' ? Number(val.toFixed(decimals)) : val;
  return `${n}${suffix}`;
}

export function toGB(mb) {
  if (mb == null) return '--';
  return (mb / 1024).toFixed(1);
}

export function pad(str, len) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, len - s.length));
}

export function pctColor(pct) {
  if (pct > 0.9) return 'red';
  if (pct > 0.7) return 'yellow';
  return 'green';
}

const THROTTLE_LABELS = {
  hw_thermal_slowdown: 'THERM',
  sw_thermal_slowdown: 'SW-THERM',
  sw_power_cap: 'PWR-CAP',
  hw_power_brake_slowdown: 'PWR-BRAKE',
};

export function throttleBadges(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return '';
  const labels = reasons.map(r => THROTTLE_LABELS[r] || r.toUpperCase());
  return ' ' + labels.map(l => ` ${l} `).join('');
}

export function fmtUptime(ms) {
  if (!ms || ms < 0) return '--:--:--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(ss)}`;
}

// Parse the model's actual port out of a formatted launch command
// ("... --port 8080 ..."), defaulting to 8080.
export function portFromCommand(command, fallback = 8080) {
  if (!command) return fallback;
  const m = String(command).match(/--port[= ](\d+)/);
  return m ? parseInt(m[1], 10) : fallback;
}
