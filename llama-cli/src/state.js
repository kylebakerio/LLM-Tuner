import { useSyncExternalStore } from 'react';

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
const COMPLETION_CAP = 50;
const LOG_CAP = 200;

// Live-progress buffer pushes are rate-limited so a chatty GEN_PROGRESS line
// stream (one per decoded batch) doesn't smear the sparklines.
const LIVE_PUSH_MIN_GAP_MS = 200;

function pushRing(arr, v) {
  arr.push(v);
  if (arr.length > BUFFER_SIZE) arr.shift();
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
    },
    modelUpSince: null,
    telemetry: null, // latest { master, worker } stats
    netMbps: 0,
    buffers: {
      mUtil: [], mVram: [], mPwr: [], mTemp: [],
      wUtil: [], wVram: [],
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
      const b = s.buffers;
      if (row.promptTps != null) pushRing(b.promptTps, row.promptTps);
      if (row.genTps != null) pushRing(b.genTps, row.genTps);
      const entry = {
        ...row,
        time: row.timestamp ? new Date(row.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString(),
      };
      return { completions: [...s.completions, entry].slice(-COMPLETION_CAP) };
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
        },
      };
      // 'ready' is the running state (see server4.js state machine).
      if (evt.state === 'ready' && prev !== 'ready') patch.modelUpSince = Date.now();
      if (evt.state && evt.state !== 'ready') patch.modelUpSince = null;
      store.setState(patch);

      const log = typeof evt.log === 'string' ? evt.log : '';
      if (!log) return;

      if (log.startsWith('PREFILL_PROGRESS:')) {
        const parts = log.split(':');
        const tps = parseFloat(parts[2]);
        store.setState((st) => ({
          live: { ...st.live, promptTps: Number.isFinite(tps) ? tps : st.live.promptTps, active: true },
        }));
        const now = Date.now();
        if (Number.isFinite(tps) && now - lastLivePush.promptTps > LIVE_PUSH_MIN_GAP_MS) {
          lastLivePush.promptTps = now;
          store.setState((st) => { pushRing(st.buffers.promptTps, tps); return {}; });
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
          store.setState((st) => { pushRing(st.buffers.genTps, avg); return {}; });
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
            active: busy || st.live.active,
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

    onTelemetry({ t, stats }) {
      if (!stats || !stats.master) return;
      const m = stats.master;
      const w = stats.worker;
      const now = t || Date.now();

      let net = 0;
      const totalBytes = (m.net_bytes || 0) + (w && w.net_bytes || 0);
      if (lastNet.bytes !== null) {
        const dt = (now - lastNet.ts) / 1000;
        if (dt > 0.2) net = Math.max(0, (totalBytes - lastNet.bytes) / dt / (1024 * 1024));
      }
      lastNet = { bytes: totalBytes, ts: now };

      store.setState((s) => {
        const b = s.buffers;
        pushRing(b.mUtil, m.gpu_util || 0);
        pushRing(b.mVram, m.vram_used || 0);
        pushRing(b.mPwr, m.gpu_pwr || 0);
        pushRing(b.mTemp, m.gpu_temp || 0);
        if (w && w.gpu_name && w.gpu_name !== 'Offline') {
          pushRing(b.wUtil, w.gpu_util || 0);
          pushRing(b.wVram, w.vram_used || 0);
        }
        pushRing(b.net, net);
        return { telemetry: stats, netMbps: net };
      });
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
