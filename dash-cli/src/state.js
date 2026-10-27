import { useSyncExternalStore } from 'react';
import { fmtTime, gpuOnline, telemetryPanels, netBytesOf } from './format.js';
import { normalizeTopology } from './topology.js';

// Minimal external store (subscribe/getState/setState) so the TUI can render
// from data pushed by the SSE stream + telemetry poller without prop-drilling.
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const f of [...subs]) f(state);
    },
    subscribe: (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

const BUFFER_SIZE = 240; // ~2 min at a 2s effective cadence
// Per-GPU histories kept at once: a launch with a different device list
// leaves the previous keys behind, pruned past this many.
const GPU_BUFFER_KEYS_MAX = 16;
const COMPLETION_CAP = 50;
const LOG_CAP = 200;

// Live-progress buffer pushes are rate-limited so a chatty GEN_PROGRESS line
// stream (one per decoded batch) doesn't smear the sparklines.
const LIVE_PUSH_MIN_GAP_MS = 200;

// Returns a NEW ring (never mutates the one in the store): the pushers run
// inside setState callbacks, and in-place mutation there is the kind of thing
// that breaks the moment the store gains memoization or a subscriber caches
// the previous state.
function pushRing(arr, v) {
  const next = arr.length >= BUFFER_SIZE ? arr.slice(1) : arr.slice();
  next.push(v);
  return next;
}

export function createAppStore() {
  const store = createStore({
    conn: 'connecting', // connecting | live | reconnecting
    server: {
      state: 'stopped', // stopped | starting | loading | ready | stopping
      model: '',
      isRpc: false,
      launchCommand: '',
      launchConfig: null,
      loadStartTime: 0,
      finalLoadTime: 0,
      error: '',
      // Unmanaged llama-server on :8080 the dashboard is polling via /slots
      // ({ port, model, busy, ... } -- see pollExternalSlots in server4.js),
      // else null. The server's state stays 'stopped' while it is set.
      external: null,
    },
    modelUpSince: null,
    telemetry: null, // latest stats: { hosts, gpus, devices } (+ legacy master/worker)
    // The machine's cards and RPC workers (topology.js normalizeTopology of
    // GET /api/topology); null until the server has said -- "unknown", which
    // Monitor and Launch treat as "label nothing from it".
    topology: null,
    // Benchmark-queue lanes with an item running, from the telemetry answer
    // ([{ lane, label, gpu, model, phase, gen, prefill, index, total }]).
    lanes: [],
    netMbps: 0,
    buffers: {
      // GPU histories keyed by panel key (format.js telemetryPanels):
      // { [key]: { util, vram, pwr, temp } }
      gpus: {},
      net: [], promptTps: [], genTps: [],
    },
    live: { promptTps: null, genTps: null, genInst: null, ctxUsed: 0, ctxTotal: 0, active: false },
    completions: [], // newest last
    logTail: [],
    benchTail: [],
  });

  const seenRunIds = new Set();
  const lastNet = { bytes: null, ts: null };
  const lastLivePush = { promptTps: 0, genTps: 0 };

  function noteCompletion(row) {
    if (row.runId) {
      if (seenRunIds.has(row.runId)) return;
      seenRunIds.add(row.runId);
    }
    store.setState((s) => {
      const entry = {
        ...row,
        time: row.timestamp ? fmtTime(row.timestamp) : fmtTime(),
      };
      const buffers = {
        ...s.buffers,
        promptTps: row.promptTps != null ? pushRing(s.buffers.promptTps, row.promptTps) : s.buffers.promptTps,
        genTps: row.genTps != null ? pushRing(s.buffers.genTps, row.genTps) : s.buffers.genTps,
      };
      return { completions: [...s.completions, entry].slice(-COMPLETION_CAP), buffers };
    });
  }

  const api = {
    store,

    onConnState(conn) {
      store.setState({ conn });
    },

    onSSEEvent(evt) {
      if (!evt || typeof evt !== 'object') return;
      const s = store.getState();
      const prev = s.server.state;

      const patch = {
        server: {
          state: evt.state ?? prev,
          model: evt.model ?? '',
          isRpc: !!evt.isRpc,
          launchCommand: evt.launchCommand ?? '',
          launchConfig: evt.launchConfig ?? null,
          loadStartTime: evt.loadStartTime || 0,
          finalLoadTime: evt.finalLoadTime || 0,
          error: evt.error || '',
          external: evt.external ?? null,
        },
      };
      // 'ready' is the running state (see server4.js state machine).
      // Only start the uptime clock when we actually OBSERVE the transition
      // (starting/loading -> ready); if the first event already says ready,
      // the model has been up longer than this session and we don't know when
      // it started (the SSE carries no start timestamp for that case).
      if (evt.state === 'ready' && prev !== 'ready') {
        patch.modelUpSince = (prev === 'starting' || prev === 'loading') ? Date.now() : null;
      }
      if (evt.state && evt.state !== 'ready') patch.modelUpSince = null;
      // A server that says when the running model came up (`startedAt`, ms
      // epoch) settles it for a model that was already running, too.
      if (evt.state === 'ready' && Number.isFinite(evt.startedAt) && evt.startedAt > 0) patch.modelUpSince = evt.startedAt;
      store.setState(patch);

      const log = typeof evt.log === 'string' ? evt.log : '';
      if (!log) return;

      if (log.startsWith('PREFILL_PROGRESS:')) {
        const parts = log.split(':');
        // parts[2] is llama.cpp's CUMULATIVE rate (n/elapsed -- it decays
        // across a long prefill and looks like a rate but is a running
        // average). parts[4] is the server-derived INSTANTANEOUS rate; older
        // servers omit it, so fall back to the cumulative one.
        const inst = parseFloat(parts[4]);
        const tps = Number.isFinite(inst) ? inst : parseFloat(parts[2]);
        store.setState((st) => ({
          live: { ...st.live, promptTps: Number.isFinite(tps) ? tps : st.live.promptTps, active: true },
        }));
        const now = Date.now();
        if (Number.isFinite(tps) && now - lastLivePush.promptTps > LIVE_PUSH_MIN_GAP_MS) {
          lastLivePush.promptTps = now;
          store.setState((st) => ({ buffers: { ...st.buffers, promptTps: pushRing(st.buffers.promptTps, tps) } }));
        }
      } else if (log.startsWith('GEN_PROGRESS:')) {
        const parts = log.split(':');
        const avg = parseFloat(parts[1]);
        const inst = parseFloat(parts[2]);
        store.setState((st) => ({
          live: {
            ...st.live,
            genTps: Number.isFinite(avg) ? avg : st.live.genTps,
            genInst: Number.isFinite(inst) ? inst : st.live.genInst,
            active: true,
          },
        }));
        const now = Date.now();
        if (Number.isFinite(avg) && now - lastLivePush.genTps > LIVE_PUSH_MIN_GAP_MS) {
          lastLivePush.genTps = now;
          store.setState((st) => ({ buffers: { ...st.buffers, genTps: pushRing(st.buffers.genTps, avg) } }));
        }
      } else if (log.startsWith('CTX_LIVE:')) {
        const parts = log.split(':');
        const used = parseInt(parts[1], 10);
        const total = parseInt(parts[2], 10);
        const busy = parts[3] === '1';
        store.setState((st) => ({
          live: {
            ...st.live,
            ctxUsed: Number.isFinite(used) ? used : st.live.ctxUsed,
            ctxTotal: Number.isFinite(total) ? total : st.live.ctxTotal,
            // An external server never sends COMPLETION (its requests are
            // logged by the benchmark's importer), so its busy flag is the
            // only end-of-request signal; managed servers keep the sticky OR.
            active: evt.external ? busy : (busy || st.live.active),
          },
        }));
      } else if (log.startsWith('COMPLETION:')) {
        let row;
        try {
          row = JSON.parse(log.slice('COMPLETION:'.length));
        } catch {
          return;
        }
        noteCompletion(row);
        store.setState((st) => ({
          live: { ...st.live, promptTps: null, genTps: null, genInst: null, active: false },
        }));
      } else if (log.startsWith('BENCH:')) {
        store.setState((st) => ({ benchTail: [...st.benchTail, log.slice('BENCH:'.length)].slice(-LOG_CAP) }));
      } else {
        store.setState((st) => ({ logTail: [...st.logTail, log].slice(-LOG_CAP) }));
      }
    },

    // A topology answer (/api/topology, or the copy sent with /api/profiles).
    // Anything without a `cards` array leaves the last known one in place.
    onTopology(raw) {
      const topology = normalizeTopology(raw);
      if (!topology) return;
      if (JSON.stringify(topology) !== JSON.stringify(store.getState().topology)) store.setState({ topology });
    },

    onTelemetry({ t, stats, lanes }) {
      if (Array.isArray(lanes)) store.setState({ lanes: lanes.filter((l) => l && typeof l === 'object') });
      if (!stats || (!stats.master && !Array.isArray(stats.gpus))) return;
      const now = t || Date.now();

      let net = 0;
      const totalBytes = netBytesOf(stats);
      if (lastNet.bytes !== null) {
        const dt = (now - lastNet.ts) / 1000;
        if (dt > 0.2) net = Math.max(0, (totalBytes - lastNet.bytes) / dt / (1024 * 1024));
      }
      lastNet.bytes = totalBytes;
      lastNet.ts = now;

      // Build the next ring set OUTSIDE the setState callback (pushRing
      // returns new arrays), so the callback is a pure state transformation.
      // One history per GPU panel; an offline reading (monitor.py's error
      // fallback, or a launch device with no telemetry) records nothing.
      const s = store.getState();
      const b = s.buffers;
      const gpus = { ...b.gpus };
      const seen = new Set();
      for (const p of telemetryPanels(stats, s.server.isRpc, s.topology)) {
        seen.add(p.key);
        if (!gpuOnline(p.gpu)) continue;
        const cur = gpus[p.key] || { util: [], vram: [], pwr: [], temp: [] };
        gpus[p.key] = {
          util: pushRing(cur.util, p.gpu.gpu_util || 0),
          vram: pushRing(cur.vram, p.gpu.vram_used || 0),
          pwr: pushRing(cur.pwr, p.gpu.gpu_pwr || 0),
          temp: pushRing(cur.temp, p.gpu.gpu_temp || 0),
        };
      }
      for (const k of Object.keys(gpus)) {
        if (Object.keys(gpus).length <= GPU_BUFFER_KEYS_MAX) break;
        if (!seen.has(k)) delete gpus[k];
      }
      const buffers = { ...b, gpus, net: pushRing(b.net, net) };
      store.setState({ telemetry: stats, netMbps: net, buffers });
    },

    // Backfill from GET /api/logs/recent on first connect. Deduped against
    // live COMPLETION events by run_id.
    backfillCompletions(rows) {
      if (!Array.isArray(rows)) return;
      for (const r of rows) noteCompletion(r);
    },
  };

  return api;
}

// React hook: subscribe a component to the store.
export function useAppStore(appStore) {
  return useSyncExternalStore(appStore.store.subscribe, appStore.store.getState);
}
