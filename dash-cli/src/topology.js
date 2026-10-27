// The machine the dashboard runs on, as the server describes it (GET
// /api/topology; also sent with /api/profiles and /api/devices), and the
// questions Launch and Monitor ask of it. Pure, no imports: format.js builds
// on this file. Nothing here (or in a caller) names a particular card -- every
// label comes from the topology or is derived from a device's own name.
//
//   topology  { cards: [{ key, name, short, label, vendor, ordinal, count,
//               vramMib, ids, preferredId, orderAssumed }], hostRamMib,
//               workers: [{ name, ... }], signature }
//   card      one PHYSICAL card. llama.cpp lists it once per backend, so `ids`
//             holds every id that reaches it (ROCm1 and Vulkan1); identical
//             cards are told apart by `ordinal` and labelled "#1", "#2".
//
// A server that sends no topology (older code, or the device probe has not
// answered yet) is `null` here -- "unknown", which is not the same as a
// machine with no cards (`cards: []`). Callers keep their topology-free
// behaviour for null.

// Card identity across listings -- the device lists of different backends,
// nvidia-smi and amdgpu_top name one card slightly differently ("AMD Radeon
// RX 7900 XTX (RADV NAVI31)" vs "AMD Radeon RX 7900 XTX"). Same normalization
// as the server's lib/devices.js gpuKey.
export function gpuKey(name) {
  return String(name || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
}

// Short card label, derived from the card's own name by dropping the driver
// note in parentheses and the vendor / product-line words: "AMD Radeon RX
// 7900 XTX (RADV NAVI31)" -> "RX 7900 XTX", "NVIDIA GeForce RTX 4090 Laptop
// GPU" -> "RTX 4090 Laptop", "Intel(R) Arc(TM) A770 Graphics" -> "Arc A770".
// The server's lib/topology.js shortName.
export function shortGpuName(name) {
  return String(name || '')
    .replace(/\((R|TM|C)\)/gi, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(AMD|NVIDIA|Intel|Advanced Micro Devices,? Inc\.?|Corporation)\b/gi, ' ')
    .replace(/\b(Radeon|GeForce|Graphics|GPU)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || String(name || '').trim();
}

export const backendOf = (id) => String(id || '').replace(/\d+$/, '');
export const isRemoteId = (id) => /^RPC\d*$/i.test(String(id || ''));

// Number identical entries: [{ name }] -> the same objects' { ordinal, count,
// short, label } ("RX 7900 XTX #2" only when there is more than one of them).
// `groupOf` narrows "identical" (the host, for telemetry readings).
export function labelIdentical(list, groupOf = () => '') {
  const k = (x) => `${groupOf(x)}|${gpuKey(x.name)}`;
  const counts = new Map();
  for (const x of list) counts.set(k(x), (counts.get(k(x)) || 0) + 1);
  const seen = new Map();
  return list.map((x) => {
    const ordinal = (seen.get(k(x)) || 0) + 1;
    seen.set(k(x), ordinal);
    const count = counts.get(k(x));
    const short = shortGpuName(x.name);
    return { ordinal, count, short, label: count > 1 ? `${short} #${ordinal}` : short };
  });
}

const gbOf = (mib) => Math.round((Number(mib) || 0) / 1024);

// "2x RX 7900 XTX 24G | 63G RAM", "RTX 4090 24G + RX 7900 XTX 24G | 63G RAM",
// "no GPU | 31G RAM" -- the server's signature format, for a topology that
// came without one.
function signatureFor(cards, hostRamMib) {
  const groups = [];
  for (const c of cards) {
    const g = groups.find((x) => x.key === gpuKey(c.name));
    if (g) g.n += 1;
    else groups.push({ key: gpuKey(c.name), n: 1, short: c.short, vramMib: c.vramMib });
  }
  const gpus = groups.map((g) => `${g.n > 1 ? `${g.n}x ` : ''}${g.short}${g.vramMib ? ` ${gbOf(g.vramMib)}G` : ''}`);
  return [gpus.length ? gpus.join(' + ') : 'no GPU', hostRamMib ? `${gbOf(hostRamMib)}G RAM` : null].filter(Boolean).join(' | ');
}

// The server's topology, checked: null unless it carries a `cards` array.
// Missing per-card fields are derived (labels and ordinals from the names) so
// the rest of the client reads one shape.
export function normalizeTopology(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.cards)) return null;
  const raw = t.cards.filter((c) => c && typeof c === 'object' && (c.name || c.label || c.short));
  const named = raw.map((c) => ({ ...c, name: String(c.name || c.short || c.label) }));
  const derived = labelIdentical(named);
  const cards = named.map((c, i) => {
    const ids = Array.isArray(c.ids) ? c.ids.map(String).filter(Boolean) : [];
    return {
      key: c.key ? String(c.key) : `${gpuKey(c.name)}#${derived[i].ordinal}`,
      name: c.name,
      short: c.short ? String(c.short) : derived[i].short,
      label: c.label ? String(c.label) : derived[i].label,
      vendor: c.vendor ? String(c.vendor) : 'other',
      ordinal: Number.isInteger(c.ordinal) ? c.ordinal : derived[i].ordinal,
      count: Number.isInteger(c.count) ? c.count : derived[i].count,
      vramMib: Number.isFinite(Number(c.vramMib)) ? Number(c.vramMib) : 0,
      ids,
      preferredId: c.preferredId ? String(c.preferredId) : (ids[0] || ''),
      orderAssumed: !!c.orderAssumed,
    };
  });
  const ram = Number(t.hostRamMib);
  const hostRamMib = Number.isFinite(ram) && ram > 0 ? ram : null;
  const workers = (Array.isArray(t.workers) ? t.workers : [])
    .map((w) => (typeof w === 'string' ? { name: w } : w))
    .filter((w) => w && w.name);
  return {
    cards, hostRamMib, workers,
    signature: typeof t.signature === 'string' && t.signature.trim() ? t.signature.trim() : signatureFor(cards, hostRamMib),
  };
}

// A topology from /api/devices `cards` ([{ name, vendor, backends: [{ id,
// totalMib }], preferredId }]) for a server that sends that list but no
// `topology` of its own.
export function topologyFromCatalog(cards, workers = []) {
  if (!Array.isArray(cards)) return null;
  return normalizeTopology({
    cards: cards.filter((c) => c && c.name).map((c) => {
      const backends = Array.isArray(c.backends) ? c.backends.filter((b) => b && b.id) : [];
      return {
        name: c.name,
        vendor: c.vendor,
        vramMib: Math.max(0, ...backends.map((b) => Number(b.totalMib) || 0)),
        ids: backends.map((b) => b.id),
        preferredId: c.preferredId || (backends[0] && backends[0].id) || '',
      };
    }),
    workers,
  });
}

// The physical card a device id reaches, or null (unknown id, no topology).
export function cardOfId(topology, id) {
  const want = String(id || '').trim();
  if (!want || !topology) return null;
  return topology.cards.find((c) => c.ids.includes(want)) || null;
}

// What to call one launch device ({ id, name? } or { worker }): the topology
// card's label when its id reaches a card of that name here, else the short
// form of the name it was saved with, else the bare id.
export function deviceLabel(topology, d) {
  if (!d) return '';
  if (d.worker) return `${d.worker} (RPC)`;
  const c = cardOfId(topology, d.id);
  if (c && (!d.name || gpuKey(c.name) === gpuKey(d.name))) return c.label;
  return d.name ? shortGpuName(d.name) : String(d.id || '');
}

// Where a launch sits, in the server's lib/topology.js placementLabel wording:
// "RX 7900 XTX #2 alone", "2x RX 7900 XTX, 1:1", "RTX 4090 + RX 7900 XTX,
// 3:1", "CPU only". Used when the server sent no `placement` (an older
// server, the running config, the editor's draft).
export function placementText(devices, topology = null) {
  const parts = (devices || []).filter(Boolean).map((d) => {
    const c = d.worker ? null : cardOfId(topology, d.id);
    const same = c && (!d.name || gpuKey(c.name) === gpuKey(d.name));
    return {
      label: deviceLabel(topology, d),
      short: d.worker ? null : (same ? c.short : (d.name ? shortGpuName(d.name) : null)),
      share: d.share,
    };
  });
  if (parts.length === 0) return 'CPU only';
  if (parts.length === 1) return `${parts[0].label} alone`;
  const shares = parts.map((p) => Number(p.share) || 0);
  const gcd = shares.reduce((a, b) => { while (b) [a, b] = [b, a % b]; return a; }, 0) || 1;
  const ratio = shares.every((s) => s > 0) ? `, ${shares.map((s) => Math.round(s / gcd)).join(':')}` : '';
  const allSame = parts.every((p) => p.short && p.short === parts[0].short);
  return (allSame ? `${parts.length}x ${parts[0].short}` : parts.map((p) => p.label).join(' + ')) + ratio;
}

// ---- can a saved profile run here (/api/profiles `availability`) ----

export const AVAILABILITY = ['ready', 'moved', 'substitute', 'unavailable'];

// One profile's availability entry, checked. A server that sends none (or an
// entry this client does not understand) reads as ready: every profile stays
// launchable exactly as before. `devices` -- only for 'moved' / 'substitute',
// only when the server sends it -- is the profile's device list re-pointed at
// this machine: what the config editor loads in place of the saved list (a
// launch sends the saved list; /api/start resolves it the same way).
export function normalizeAvailability(a) {
  const status = a && AVAILABILITY.includes(a.status) ? a.status : 'ready';
  const out = {
    status,
    reason: a && typeof a.reason === 'string' ? a.reason.trim() : '',
    placement: a && typeof a.placement === 'string' && a.placement.trim() ? a.placement.trim() : null,
  };
  if ((status === 'moved' || status === 'substitute') && Array.isArray(a.devices) && a.devices.length > 0) out.devices = a.devices;
  return out;
}

// ---- telemetry readings -> physical cards (Monitor) ----

// For each topology card, the local telemetry GPU entry that is that card.
// The server says so itself when it can: each reading carries `card`, its
// topology card key (lib/telemetry.js labelGpus). For a server that does not,
// the same rule is applied here: matched by card name, identical cards in PCI
// address order (the n-th reading of a model is card #n). Nothing ties a PCI
// address to a llama.cpp id, so for identical cards that order is an
// assumption either way -- the topology's `orderAssumed`. The names come from
// different tools (llama.cpp's device list vs nvidia-smi / amdgpu_top) and
// may not agree on a card this client has never seen: cards and readings left
// over after the name match are paired by vendor, in order, when a vendor has
// as many leftover cards as leftover readings -- one card shown once, not an
// offline panel beside an unlabelled reading.
// Returns { byCard: Map(card.key -> gpu), rest: [gpu] } -- `rest` is every
// entry that is no card of this topology (another host's, or one this build
// of llama.cpp does not list).
export function matchGpusToCards(gpus, topology) {
  const list = (Array.isArray(gpus) ? gpus : []).filter(Boolean);
  const cards = (topology && topology.cards) || [];
  const isLocal = (x) => (x.host || 'local') === 'local';
  const claimed = new Set();
  const byCard = new Map();
  const claim = (c, g) => { claimed.add(g); byCard.set(c.key, g); };
  for (const c of cards) {
    const g = list.find((x) => !claimed.has(x) && isLocal(x) && x.card && x.card === c.key);
    if (g) claim(c, g);
  }
  const byPci = list.slice().sort((a, b) => String(a.pci || '').localeCompare(String(b.pci || '')) || (a.index || 0) - (b.index || 0));
  for (const c of cards) {
    if (byCard.has(c.key)) continue;
    const g = byPci.find((x) => !claimed.has(x) && isLocal(x) && gpuKey(x.gpu_name) === gpuKey(c.name));
    if (g) claim(c, g);
  }
  const vendors = new Set(cards.filter((c) => !byCard.has(c.key) && c.vendor && c.vendor !== 'other').map((c) => c.vendor));
  for (const v of vendors) {
    const freeCards = cards.filter((c) => !byCard.has(c.key) && c.vendor === v);
    const freeGpus = byPci.filter((x) => !claimed.has(x) && isLocal(x) && x.vendor === v);
    if (freeCards.length !== freeGpus.length) continue;
    freeCards.forEach((c, i) => { claimed.add(freeGpus[i]); byCard.set(c.key, freeGpus[i]); });
  }
  return { byCard, rest: list.filter((g) => !claimed.has(g)) };
}
