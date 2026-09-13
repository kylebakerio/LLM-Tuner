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

// Throttle badges with the dashboard's hard-won corrections (same rules as
// server4.js isRealThermal / DEPTH-TESTING.md §4.5):
//  - hw_thermal_slowdown is real hardware protection -- authoritative alone.
//  - sw_thermal_slowdown asserts at idle/low clocks on this card (through the
//    whole model load at 40-52C, quiet under load at 60-63C) -- it means
//    "clocks below max", not "too hot". Trust it only with a hot reading
//    (>= 75C).
//  - sw_power_cap is a permanently-active firmware cap (80W on this rig) --
//    not a thermal signal at all; shown dim as reference only.
//  - hw_power_brake_slowdown is a genuine external power limit.
// `dev` is a telemetry device object ({ throttle_reasons, gpu_temp }).
// Returns { segments: [{label, level}] } in priority order (real > warn >
// info); maxWidth trims the string to fit the panel, dropping the lowest
// priority first.
const THERMAL_TEMP_FLOOR = 75;
export function throttleBadges(dev, maxWidth = Infinity) {
  const reasons = (dev && Array.isArray(dev.throttle_reasons)) ? dev.throttle_reasons.map(String) : [];
  const temp = Number(dev && dev.gpu_temp);
  const has = (re) => reasons.some((r) => re.test(r));
  const items = [];
  if (has(/hw_thermal/i)) items.push({ label: 'THERM', level: 'real' });
  else if (has(/thermal/i) && Number.isFinite(temp) && temp >= THERMAL_TEMP_FLOOR) items.push({ label: 'SW-THERM', level: 'real' });
  if (has(/hw_power_brake/i)) items.push({ label: 'PWR-BRAKE', level: 'warn' });
  if (has(/sw_power_cap/i)) items.push({ label: 'pwr-cap', level: 'info' });
  const prio = { real: 0, warn: 1, info: 2 };
  const sorted = items.slice().sort((a, b) => prio[a.level] - prio[b.level]);
  const segments = [];
  let len = 0;
  for (const it of sorted) {
    const add = (segments.length ? ' ' : '') + it.label;
    if (len + add.length > maxWidth) continue;
    segments.push(it);
    len += add.length;
  }
  if (segments.length === 0 && sorted.length > 0) segments.push(sorted[0]); // never hide a real thermal
  return { segments };
}

// Is this telemetry device object real data? monitor.py's unreachable/failed
// fallback dict still carries gpu_util: 0 etc., so a defined field proves
// nothing -- check the name AND both vendors' error flags (the master may be
// the AMD card, the worker the NVIDIA one, or either way round).
export function gpuOnline(g) {
  return !!(g && g.gpu_name && g.gpu_name !== 'Offline' && g.nvidia_smi_error !== true && g.amdgpu_top_error !== true);
}

// GPU panel titles: an RPC run is "this host" vs "the worker", not two
// indices on one machine.
export function gpuTitles(isRpc) {
  return isRpc ? ['Local', 'Worker (rpc)'] : ['GPU 0', 'GPU 1'];
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

// HH:MM:SS (24h) for fixed-width time columns.
export function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toTimeString().slice(0, 8);
}

// Parse the model's actual port out of a formatted launch command
// ("... --port 8080 ..."), defaulting to 8080.
export function portFromCommand(command, fallback = 8080) {
  if (!command) return fallback;
  const m = String(command).match(/--port[= ](\d+)/);
  return m ? parseInt(m[1], 10) : fallback;
}
