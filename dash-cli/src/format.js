import { createRequire } from 'node:module';
import { gpuKey, shortGpuName, labelIdentical, matchGpusToCards } from './topology.js';

// Card names: one normalization (gpuKey) and one short form (shortGpuName),
// both in topology.js -- derived from the card's own name, never a literal.
export { gpuKey, shortGpuName };

// Model display names: the dashboard's one helper (ui/shared/modelname.js, shared with the browser
// and server4.js). modelName() drops a split model's "-00001-of-00003"; isLaunchableModel() keeps
// /api/models entries that are models (not mmproj files, draft heads or template carriers).
const ModelName = createRequire(import.meta.url)('../../ui/shared/modelname.js');
export const { modelName, stripSplitIn, modelFileKind } = ModelName;
export const isLaunchableModel = (m) => !!m && (m.kind || modelFileKind(m.path || m.name, m.bytes)) === 'model';

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

// A card label cut to `max` columns with its ordinal kept: two identical
// cards differ only in the "#1" / "#2" at the END of the label, which is the
// part a plain cut removes ("RX 7900 XT…" twice). The name gives way first
// ("RX 790… #2"); what follows the ordinal (" alone", " · ROCm1 50%") is
// kept as far as it fits. A label with no ordinal is cut as usual.
export function clipLabel(label, max) {
  const str = String(label == null ? '' : label);
  if (max <= 0) return '';
  if (str.length <= max) return str;
  const m = /^(.*?)(\s?#\d+)(?!\d)(.*)$/.exec(str);
  if (!m || m[2].length + 2 > max) return max === 1 ? '…' : `${str.slice(0, max - 1)}…`;
  const [, head, ord, tail] = m;
  if (head.length + ord.length <= max) {
    const room = max - head.length - ord.length;
    return `${head}${ord}${room >= 2 ? `${tail.slice(0, room - 1)}…` : (room === 1 && tail ? '…' : '')}`;
  }
  return `${head.slice(0, max - ord.length - 1).trimEnd()}…${ord}`;
}

// The temperature row of a GPU panel: the card's own temperature, then the
// sensors only some cards have -- memory (junction) temperature and the fan,
// as rpm when the card reports it (with the duty in brackets when there is
// room), else as a percentage. A sensor the card does not have is left out,
// not shown as "--" (monitor.py sends null: NVIDIA has no fan rpm and no
// memory temperature; AMD has all three). A stopped fan (0 rpm) is a
// reading. Parts are dropped from the end until the line fits `maxWidth`.
const reading = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function thermalParts(g) {
  if (!g) return [];
  const temp = reading(g.gpu_temp), mem = reading(g.mem_temp), rpm = reading(g.fan_rpm), pct = reading(g.fan_pct);
  const out = [];
  if (temp != null) out.push({ key: 'temp', text: `${Math.round(temp)}°C` });
  if (mem != null) out.push({ key: 'mem', text: `mem ${Math.round(mem)}°C` });
  if (rpm != null) out.push({ key: 'fan', text: `fan ${Math.round(rpm)} rpm`, more: pct != null ? ` (${Math.round(pct)}%)` : '' });
  else if (pct != null) out.push({ key: 'fan', text: `fan ${Math.round(pct)}%` });
  return out;
}
export function thermalLine(g, maxWidth = Infinity) {
  const parts = thermalParts(g);
  const join = (list, full) => list.map((p) => p.text + (full && p.more ? p.more : '')).join(' · ');
  if (join(parts, true).length <= maxWidth) return join(parts, true);
  for (let n = parts.length; n > 0; n--) {
    const line = join(parts.slice(0, n), false);
    if (line.length <= maxWidth) return line;
  }
  return parts.length ? parts[0].text.slice(0, Math.max(0, maxWidth)) : '';
}

// Is this telemetry device object real data? monitor.py's unreachable/failed
// fallback dict still carries gpu_util: 0 etc., so a defined field proves
// nothing -- check the name AND both vendors' error flags (the master may be
// the AMD card, the worker the NVIDIA one, or either way round).
export function gpuOnline(g) {
  return !!(g && g.gpu_name && g.gpu_name !== 'Offline' && g.nvidia_smi_error !== true && g.amdgpu_top_error !== true);
}

// GPU panel titles for the legacy master/worker telemetry pair: an RPC run is
// "this host" vs "the worker", not two indices on one machine.
export function gpuTitles(isRpc) {
  return isRpc ? ['Local', 'Worker (rpc)'] : ['GPU 0', 'GPU 1'];
}

const OFFLINE_GPU = { gpu_name: 'Offline', nvidia_smi_error: true };

// One panel per physical card of the topology, then every other GPU the
// telemetry reports (another host's -- an RPC worker's cards -- or one this
// build of llama.cpp does not list).
//   title  -- the card's topology label ("RX 7900 XTX #2"); another host's
//             card is "<short name>@<host>"
//   name   -- during a launch: the device id the launch uses on that card and
//             its share ("ROCm1 50%"), or "not in launch"; otherwise the
//             reading's PCI address when the server sends one, else '' (never
//             null: null asks GpuBox to derive a name from the reading, which
//             the title already is)
//   gpu    -- that card's own entry in `stats.gpus`, never the per-device
//             record (`stats.devices` says which ids a launch uses, and that
//             is all it is read for here)
//   key    -- "card|<card key>": the same through launches, stops and a card
//             dropping out of telemetry (an Offline panel, not a missing one)
// A machine with no cards and no readings gives [] (Monitor says "no GPU").
function cardPanels(stats, gpus, topology) {
  const records = (Array.isArray(stats.devices) ? stats.devices : []).filter((r) => r && typeof r === 'object');
  const inLaunch = records.length > 0;
  const shareTotal = records.length > 1 && records.every((r) => Number(r.share) > 0)
    ? records.reduce((sum, r) => sum + Number(r.share), 0) : 0;
  const note = (r) => `${r.id || 'device'}${shareTotal ? ` ${Math.round((Number(r.share) / shareTotal) * 100)}%` : ''}`;
  const hostOf = (x) => (x && x.host) || 'local';
  const reading = (g) => (g && !g.error ? g : OFFLINE_GPU);
  const { byCard, rest } = matchGpusToCards(gpus, topology);
  const used = new Set();

  // Which card each local launch device is on: the card its id reaches; for
  // an id this topology does not list (it was read from a build without that
  // backend), the card whose reading the server gave it (`pci`), else the
  // card of that name -- among identical cards the one at the id's own index
  // (ROCm1 -> the second), as llama.cpp numbers them.
  const recOfCard = new Map();
  const locals = records.filter((r) => hostOf(r) === 'local');
  for (const r of locals) {
    const c = topology.cards.find((x) => !recOfCard.has(x.key) && x.ids.includes(r.id));
    if (c) { recOfCard.set(c.key, r); used.add(r); }
  }
  for (const r of locals) {
    if (used.has(r) || !r.pci) continue;
    const c = topology.cards.find((x) => !recOfCard.has(x.key) && byCard.has(x.key) && byCard.get(x.key).pci === r.pci);
    if (c) { recOfCard.set(c.key, r); used.add(r); }
  }
  for (const r of locals) {
    if (used.has(r) || !r.name) continue;
    const same = topology.cards.filter((x) => gpuKey(x.name) === gpuKey(r.name));
    const at = Number((String(r.id || '').match(/(\d+)$/) || [])[1]);
    const c = [same[Number.isInteger(at) ? Math.min(at, same.length - 1) : 0], ...same].find((x) => x && !recOfCard.has(x.key));
    if (c) { recOfCard.set(c.key, r); used.add(r); }
  }

  const panels = topology.cards.map((c) => {
    const g = byCard.get(c.key) || null;
    const rec = recOfCard.get(c.key) || null;
    return {
      key: `card|${c.key}`,
      title: c.label,
      name: rec ? note(rec) : (inLaunch ? 'not in launch' : (g && g.pci) || ''),
      gpu: reading(g),
    };
  });

  // Local readings that are no card of this topology.
  const localRest = rest.filter((g) => hostOf(g) === 'local');
  const localLabels = labelIdentical(localRest.map((g) => ({ name: g.gpu_name })));
  localRest.forEach((g, i) => {
    const rec = records.find((r) => !used.has(r) && hostOf(r) === 'local' && r.name && gpuKey(r.name) === gpuKey(g.gpu_name)) || null;
    if (rec) used.add(rec);
    panels.push({
      key: `local|${g.pci || g.index}|${g.gpu_name}`,
      title: g.label || localLabels[i].label || 'GPU',
      name: rec ? note(rec) : (inLaunch ? 'not in launch' : g.pci || ''),
      gpu: reading(g),
    });
  });

  // Other hosts, in the order the launch (then the telemetry) names them: the
  // n-th launch device on a host is that host's n-th GPU, and a device whose
  // host sent no reading keeps its panel.
  const hosts = [...new Set([...records.map(hostOf), ...rest.map(hostOf)])].filter((hname) => hname !== 'local');
  for (const host of hosts) {
    const mine = rest.filter((g) => hostOf(g) === host);
    const recs = records.filter((r) => hostOf(r) === host);
    const labels = labelIdentical(mine.map((g) => ({ name: g.gpu_name })));
    for (let i = 0; i < Math.max(mine.length, recs.length); i++) {
      const g = mine[i] || null;
      const rec = recs[i] || null;
      const label = g ? (g.label || labels[i].label) : (rec.label || shortGpuName(rec.name) || rec.id || 'GPU');
      panels.push({
        key: `host|${host}|${i}`,
        title: `${label}@${host}`,
        name: rec ? note(rec) : (inLaunch ? 'not in launch' : ''),
        gpu: reading(g),
      });
    }
  }
  return panels;
}

// The GPU panels Monitor draws. With the machine's topology (topology.js; the
// server's /api/topology) there is one panel per PHYSICAL card, in topology
// order, whatever is running: see cardPanels below. Without one (an older
// server, or before it has answered) the panels follow the telemetry shape:
// `stats.devices` (a launch -- one per launch device, in launch order), else
// `stats.gpus` (no launch -- every GPU the server sees), else the legacy
// `master`/`worker` pair. Each panel is { key, title, name, gpu }: `gpu` is in
// the per-node field shape GpuBox and gpuOnline read (a card with no reading
// is an Offline node), and `key` is stable per card -- the sparkline buffers
// are keyed by it.
export function telemetryPanels(stats, isRpc = false, topology = null) {
  if (!stats) return [];
  const gpus = Array.isArray(stats.gpus) ? stats.gpus : null;
  if (topology && gpus) return cardPanels(stats, gpus, topology);
  const offline = OFFLINE_GPU;
  if (Array.isArray(stats.devices) && stats.devices.length > 0) {
    const claimed = new Set();
    const launch = stats.devices.map((r, i) => {
      const host = r.host || 'local';
      // The full GPU entry carries throttle reasons and process VRAM the
      // per-device record doesn't -- find it by host + card name.
      const g = gpus && r.name
        ? gpus.find((x) => x && !claimed.has(x) && (x.host || 'local') === host && gpuKey(x.gpu_name) === gpuKey(r.name))
        : null;
      if (g) claimed.add(g);
      const hasReading = r.util != null || r.vram_used != null;
      let gpu = offline;
      if (hasReading && g && !g.error) gpu = g;
      else if (hasReading) {
        gpu = {
          gpu_name: r.name || r.id, gpu_util: r.util, vram_used: r.vram_used, vram_total: r.vram_total,
          gpu_pwr: r.pwr, gpu_temp: r.temp, throttle_reasons: [], process_vram: 0,
          mem_temp: r.mem_temp ?? null, fan_rpm: r.fan_rpm ?? null, fan_pct: r.fan_pct ?? null,
        };
      }
      const label = r.label || shortGpuName(r.name) || r.id;
      return {
        key: `${host}|${r.id || i}|${label}`,
        title: r.id || `dev ${i}`,
        name: `${label}${host !== 'local' ? `@${host}` : ''}`,
        gpu,
      };
    });
    // Cards the launch does not use still get a panel: the benchmark queue runs its own
    // servers on them (a second lane beside a one-card launch), and hiding them made a
    // busy card look absent.
    const others = (gpus || []).filter((g) => g && !claimed.has(g)).map((g) => {
      const host = g.host || 'local';
      return {
        key: `${host}|${g.pci || g.index}|${g.gpu_name}`,
        title: 'not in launch',
        name: `${shortGpuName(g.gpu_name)}${host !== 'local' ? `@${host}` : ''}`,
        gpu: g.error ? offline : g,
      };
    });
    return launch.concat(others);
  }
  if (gpus) {
    let localN = 0;
    return gpus.filter(Boolean).map((g) => {
      const host = g.host || 'local';
      return {
        key: `${host}|${g.pci || g.index}|${g.gpu_name}`,
        title: host === 'local' ? `GPU ${localN++}` : host,
        name: shortGpuName(g.gpu_name),
        gpu: g.error ? offline : g,
      };
    });
  }
  const out = [];
  const titles = gpuTitles(isRpc);
  if (stats.master) out.push({ key: 'legacy|master', title: titles[0], name: null, gpu: stats.master });
  // During an RPC run the worker panel stays up even when its telemetry drops
  // (shown as offline) -- a vanishing panel would hide exactly the failure
  // worth seeing.
  if (gpuOnline(stats.worker) || isRpc) out.push({ key: 'legacy|worker', title: titles[1], name: null, gpu: stats.worker || null });
  return out;
}

// What Monitor's GPU grid shows: telemetryPanels(), and until there is a
// reading -- or on a machine with no GPU at all -- placeholders that already
// have the final shape, so the grid does not change size when telemetry
// arrives: one waiting panel per topology card, a single "NO GPU" panel for a
// CPU-only machine (`idle` is its one line of text), or the single unnamed
// panel when nothing is known about the machine.
export function monitorPanels(stats, isRpc = false, topology = null) {
  const panels = telemetryPanels(stats, isRpc, topology);
  if (panels.length > 0) return panels;
  if (topology && topology.cards.length > 0) {
    return topology.cards.map((c) => ({ key: `card|${c.key}`, title: c.label, name: '', gpu: null }));
  }
  if (topology) return [{ key: 'none', title: 'NO GPU', name: '', gpu: null, idle: 'CPU only — this machine has no GPU' }];
  return [{ key: 'none', title: 'GPU 0', name: null, gpu: null }];
}

// One line for the benchmark-queue lanes with an item running (the `lanes`
// of the telemetry answer), e.g. "queue: <lane> (<label>) gen 19 t/s · 6/22".
// A lane on another machine has no GPU panel -- the server sends no readings
// for its cards -- so this line is all Monitor knows about it. '' = no lanes.
export function lanesLine(lanes) {
  const list = (Array.isArray(lanes) ? lanes : []).filter((l) => l && l.lane);
  if (list.length === 0) return '';
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return `queue: ${list.map((l) => {
    const gen = num(l.gen);
    const pre = num(l.prefill);
    const rate = l.phase === 'prefill' && pre != null ? `prefill ${Math.round(pre)} t/s`
      : gen != null ? `gen ${gen >= 100 ? Math.round(gen) : Math.round(gen * 10) / 10} t/s`
        : (l.phase ? String(l.phase) : (l.connected === false ? 'not connected' : 'running'));
    const at = num(l.index) != null && num(l.total) ? ` · ${num(l.index)}/${num(l.total)}` : '';
    return `${l.lane}${l.label ? ` (${l.label})` : ''} ${rate}${at}`;
  }).join('   ')}`;
}

// GPU panel grid: two per row, three once each gets ~40 columns; more panels
// wrap onto extra rows. Returns { perRow, widths (per slot), rows }.
export function panelLayout(count, cols) {
  const n = Math.max(1, count);
  const perRow = n > 2 && cols >= 3 * 40 + 2 ? 3 : 2;
  let widths;
  if (perRow === 2) {
    const half1 = Math.max(34, Math.floor((cols - 1) / 2));
    widths = [half1, Math.max(30, cols - 1 - half1)];
  } else {
    const w = Math.floor((cols - 2) / 3);
    widths = [w, w, Math.max(30, cols - 2 - 2 * w)];
  }
  return { perRow, widths, rows: Math.ceil(n / perRow) };
}

// Cumulative network bytes for the net-rate sparkline: every host's counter
// (new telemetry), else master + worker (legacy).
export function netBytesOf(stats) {
  if (!stats) return 0;
  if (stats.hosts && typeof stats.hosts === 'object') {
    return Object.values(stats.hosts).reduce((sum, h) => sum + ((h && h.net_bytes) || 0), 0);
  }
  return ((stats.master && stats.master.net_bytes) || 0) + ((stats.worker && stats.worker.net_bytes) || 0);
}

// Subsequence fuzzy match (FuzzyList and the Launch profile list): a sort
// score, lower is better, or null for no match. Case-insensitive.
export function fuzzyScore(query, text) {
  const q = String(query || '').toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let end = -1;
  for (let ti = 0; ti < t.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      end = ti;
      if (qi === q.length) break;
    }
  }
  return qi === q.length ? end : null;
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
