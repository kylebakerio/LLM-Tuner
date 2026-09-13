import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { h } from '../h.js';
import { FuzzyList } from '../components/fuzzylist.js';
import { KeymapBar } from '../components/statusbar.js';
import { useAppStore } from '../state.js';
import { listProfiles, listProfileEntries, saveProfile, deleteProfile, markProfileLoaded } from '../profiles.js';
import {
  DEFAULT_DRAFT, TRANSPORTS, VERBOSITY_MIN, sanitizeConfig, configToDraft, draftToConfig,
  nodeLabels, splitText, profileTag,
} from '../launchconfig.js';
import { pad } from '../format.js';
import { useMouseClicks, setMouseGate, APP_HEADER_ROWS } from '../mouse.js';

// The full launch-config surface, grouped (mirrors PLAN §6.3 and the server's
// buildLlamaArgs -- every key here is one buildLlamaArgs reads). Field kinds:
//   list   -> FuzzyList picker (Enter)
//   num    -> integer text editor
//   float  -> decimal text editor
//   text   -> free text
//   toggle -> Enter flips on/off
const GROUPS = [
  ['core', [
    ['modelPath', 'Model', 'list'],
    ['build', 'Build', 'list'],
    ['ctx', 'Context', 'num'],
    ['ngl', 'nGl', 'num'],
    ['port', 'Port', 'num'],
  ]],
  // RPC: an explicit on/off switch plus the worker's SSH target (alias or
  // user@host) -- collapsed into launchConfig.rpcTarget by draftToConfig.
  // While RPC is on, GPU B is locked to None (the worker IS the second node)
  // and transport appears; the GPU A / split labels become Local / Worker.
  ['hw', [
    ['deviceA', 'GPU A', 'list'],
    ['deviceB', 'GPU B', 'list'],
    ['tensorSplit', 'Tensor split', 'num'],
    ['rpcEnabled', 'RPC worker', 'toggle'],
    ['workerHost', 'Worker host', 'text'],
    ['transport', 'Transport', 'list'],
  ]],
  ['cache', [
    ['fa', 'Flash attn', 'toggle'],
    ['cacheK', 'KV cache K', 'list'],
    ['cacheV', 'KV cache V', 'list'],
  ]],
  ['spec', [
    ['specType', 'Spec type', 'list'],
    ['specDraftNMax', 'Draft n-max', 'num'],
    ['specDraftNMin', 'Draft n-min', 'num'],
    ['specDraftModel', 'Draft model', 'text'],
    ['specDraftNgl', 'Draft nGl', 'num'],
    ['specNgramSizeN', 'Ngram size-n', 'num'],
    ['specNgramSizeM', 'Ngram size-m', 'num'],
    ['specNgramMinHits', 'Ngram min-hits', 'num'],
    ['nCpuMoe', 'n-cpu-moe', 'num'],
  ]],
  ['sample', [
    ['temp', 'Temp', 'float'],
    ['topK', 'Top-k', 'num'],
    ['topP', 'Top-p', 'float'],
    ['minP', 'Min-p', 'float'],
    ['presencePenalty', 'Presence pen.', 'float'],
    ['repeatPenalty', 'Repeat pen.', 'float'],
  ]],
  ['chat', [
    ['jinja', 'Jinja', 'toggle'],
    ['reasoningPreserve', 'Keep reasoning', 'toggle'],
    ['chatTemplateFile', 'Chat template', 'text'],
    ['mmprojEnabled', 'Multimodal', 'toggle'],
    ['mmprojPath', 'MMProj path', 'text'],
    ['mmprojOffload', 'mmproj → system RAM', 'toggle'],
    ['loadMode', 'Load mode', 'list'],
    ['verbosity', 'Verbosity', 'num'],
  ]],
  ['raw', [
    ['argString', 'Raw args', 'text'],
  ]],
];

// The draft shape (DEFAULT_DRAFT), its launch-config mapping and profile
// sanitizing live in ../launchconfig.js (pure, unit-tested). Every request
// body leaves this file through draftToConfig -- never the raw draft.

const WORKER_STATUS_POLL_MS = 5000;
const WORKER_LOGS_POLL_MS = 3000;

const NUM_SPECS = {
  ctx: { min: 1, max: 1e9, int: true },
  ngl: { min: 0, max: 1e6, int: true },
  port: { min: 1, max: 65535, int: true },
  // tensorSplit caps at 99: the server emits `-ts N,M` only for 0 <= N < 100,
  // so 100 would be silently dropped and the model would launch with llama's
  // default (even) split instead of the 100/0 split the user asked for.
  tensorSplit: { min: 0, max: 99, int: true },
  specDraftNMax: { min: 0, max: 1e4, int: true },
  specDraftNMin: { min: 0, max: 1e4, int: true },
  specDraftNgl: { min: 0, max: 1e3, int: true },
  specNgramSizeN: { min: 0, max: 1e6, int: true },
  specNgramSizeM: { min: 0, max: 1e6, int: true },
  specNgramMinHits: { min: 0, max: 1e6, int: true },
  nCpuMoe: { min: 0, max: 1e4, int: true },
  topK: { min: 0, max: 1e6, int: true },
  // Floor 3 (web clamps the same): lower levels make llama-server drop the
  // log lines the dashboard parses for status and telemetry.
  verbosity: { min: VERBOSITY_MIN, max: 10, int: true },
  temp: { min: 0, max: 100 },
  topP: { min: 0, max: 1 },
  minP: { min: 0, max: 1 },
  presencePenalty: { min: -100, max: 100 },
  repeatPenalty: { min: 0, max: 100 },
};

const KV_QUANTS = [
  ['f16', '16-bit float (default when unset)'],
  ['q8_0', '8-bit -- the usual choice at big ctx'],
  ['q8_1', '8-bit, higher accuracy'],
  ['q4_0', '4-bit -- smallest'],
  ['q4_1', '4-bit'],
  ['q5_0', '5-bit'],
  ['q5_1', '5-bit'],
  ['t_q4_0', 'ternary 4-bit'],
  ['t_q4_1', 'ternary 4-bit'],
  ['t_q5_0', 'ternary 5-bit'],
  ['t_q5_1', 'ternary 5-bit'],
  ['t_q8_0', 'ternary 8-bit'],
];
const SPEC_TYPES = [
  'draft-mtp',
  'ngram-simple',
  'ngram-map-k',
  'ngram-map-k4v',
  'draft-mtp,ngram-simple',
  'ngram-simple,ngram-map-k',
  'ngram-simple,ngram-map-k4v',
  'draft-mtp,ngram-simple,ngram-map-k4v',
];
const LOAD_MODES = ['mmap', 'mlock', 'none'];

function kindOf(field) {
  for (const [, fields] of GROUPS) {
    const f = fields.find((x) => x[0] === field);
    if (f) return f[2];
  }
  return 'text';
}
function labelOf(field, draft) {
  const rpc = !!(draft && draft.rpcEnabled);
  if (field === 'deviceA') return nodeLabels(rpc).a;
  if (field === 'deviceB') return nodeLabels(false).b;
  if (field === 'tensorSplit') return rpc ? 'Local share' : 'Tensor split';
  for (const [, fields] of GROUPS) {
    const f = fields.find((x) => x[0] === field);
    if (f) return f[1];
  }
  return field;
}

// The rows a group actually shows: transport only matters (and is only
// sent) while RPC is on, so it's hidden otherwise. The mouse hit-test and
// the up/down wrap both read this same list, so they can't drift.
function visibleFields(groupIdx, draft) {
  return GROUPS[groupIdx][1].filter(([field]) => field !== 'transport' || draft.rpcEnabled);
}

// Last `n` lines of a (possibly multi-line) server error -- the worker
// start failure carries its startup log tail.
function tailLines(text, n) {
  const lines = String(text || '').trim().split('\n');
  return lines.slice(-n).join('\n');
}

export function Launch({ appStore, client, serverUrl, modeGateRef, onLaunched }) {
  const { stdout } = useStdout();
  const cols = (stdout && stdout.columns) || 80;
  const s = useAppStore(appStore);
  const [draft, setDraft] = useState({ ...DEFAULT_DRAFT });
  const [groupIdx, setGroupIdx] = useState(0);
  const [focusIdx, setFocusIdx] = useState(0);
  const [editor, setEditor] = useState(null);
  // editor: { kind: 'list'|'text'|'name'|'profiles'|'confirm'|'flags', field?, value?, msg?, onYes?, label?, onSubmit?, flags? }
  const [catalog, setCatalog] = useState({ models: [], builds: [], devices: [] });
  const [preview, setPreview] = useState({ command: '', error: null });
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  const [activeProfile, setActiveProfile] = useState(null);
  // { status: 'running'|'stopped'|'offline'|'error'|'checking', error? } or
  // null while RPC is off.
  const [workerStatus, setWorkerStatus] = useState(null);
  const [workerPollNonce, setWorkerPollNonce] = useState(0);
  const [defaultWorkerHost, setDefaultWorkerHost] = useState('');
  const previewTimer = useRef(null);
  const prefilledRef = useRef(false);
  const workerBusyRef = useRef(false);

  const fields = visibleFields(groupIdx, draft);
  const fi = Math.min(focusIdx, fields.length - 1); // list can shrink (RPC off hides transport)
  const flash = (text, ok = true) => setStatus({ text, ok });
  const workerHost = (draft.workerHost || '').trim();
  const pollHost = draft.rpcEnabled ? workerHost : '';

  // Default worker host from the dashboard's worker config (GET
  // /api/worker/config -> { ssh }), seeded only into an empty field.
  useEffect(() => {
    let alive = true;
    client.getJson('/api/worker/config')
      .then((d) => {
        const ssh = d && typeof d.ssh === 'string' ? d.ssh.trim() : '';
        if (!alive || !ssh) return;
        setDefaultWorkerHost(ssh);
        setDraft((dd) => (dd.workerHost ? dd : { ...dd, workerHost: ssh }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [client]);

  // Worker status badge: SSH-polled by the server every 5s, only while RPC is
  // on (and this mode is mounted -- app.js unmounts Launch on a mode switch,
  // which runs the cleanup). Skips a tick while a start/stop is in flight or
  // a previous status call hasn't come back (an unreachable host can take
  // the full ssh timeout).
  useEffect(() => {
    if (!pollHost || s.conn !== 'live') { setWorkerStatus(null); return undefined; }
    let alive = true;
    let inFlight = false;
    setWorkerStatus((ws) => ws || { status: 'checking' });
    const tick = () => {
      if (inFlight || workerBusyRef.current) return;
      inFlight = true;
      client.postJson('/api/worker/status', { worker_ssh: pollHost }, { timeoutMs: 15000 })
        .then((st) => { if (alive) setWorkerStatus({ status: (st && st.status) || 'offline', error: (st && st.error) || null }); })
        .catch((err) => { if (alive) setWorkerStatus({ status: 'error', error: err.message }); })
        .finally(() => { inFlight = false; });
    };
    tick();
    const iv = setInterval(tick, WORKER_STATUS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [client, pollHost, s.conn, workerPollNonce]);

  // Worker logs overlay: refetch the last 50 lines every 3s while it's open.
  const logsOpen = !!(editor && editor.kind === 'logs');
  useEffect(() => {
    if (!logsOpen || !workerHost) return undefined;
    let alive = true;
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      client.postJson('/api/worker/logs', { worker_ssh: workerHost }, { timeoutMs: 15000 })
        .then((d) => { if (alive) setEditor((e) => (e && e.kind === 'logs' ? { ...e, text: (d && d.logs) || 'No logs returned.', error: null } : e)); })
        .catch((err) => { if (alive) setEditor((e) => (e && e.kind === 'logs' ? { ...e, error: `Failed to fetch logs: ${err.message}` } : e)); })
        .finally(() => { inFlight = false; });
    };
    tick();
    const iv = setInterval(tick, WORKER_LOGS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [client, logsOpen, workerHost]);

  // Load model + build catalogs.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [models, builds] = await Promise.all([
        client.getJson('/api/models').catch(() => []),
        client.getJson('/api/builds').catch(() => ({ builds: [] })),
      ]);
      if (!alive) return;
      const buildList = (builds && builds.builds) || [];
      setCatalog((c) => ({ ...c, models: Array.isArray(models) ? models : [], builds: buildList }));
      if (Array.isArray(models) && models.length > 0 && !prefilledRef.current) {
        // sensible defaults: first model, first configured build
        setDraft((d) => ({
          ...d,
          modelPath: d.modelPath || models[0].path,
          build: d.build || (buildList[0] && buildList[0].id) || '',
        }));
      }
    })();
    return () => { alive = false; };
  }, [client]);

  // Prefill from the server's current launchConfig (the authoritative config
  // of whatever is running), once. Copy EVERY known field: the running config
  // carries the full launch surface (KV quant, spec stack, sampling, jinja,
  // template file...), and copying only the core nine would drop them --
  // e.g. an f16-KV 262k launch silently rebuilt without --cache-type-k/v.
  // configToDraft drops rawCommand/unknown keys and expands rpcTarget into
  // the RPC switch + worker host (GPU B cleared when RPC is on).
  useEffect(() => {
    const lc = s.server.launchConfig;
    if (prefilledRef.current || !lc) return;
    prefilledRef.current = true;
    setDraft((d) => configToDraft(lc, d, { skipEmpty: true }));
  }, [s.server.launchConfig]);

  // Devices for the selected build.
  useEffect(() => {
    let alive = true;
    if (!draft.build) {
      setCatalog((c) => ({ ...c, devices: [] }));
      return;
    }
    // 15s: the server shells out to the Vulkan/CUDA loader for
    // --list-devices, which itself allows an 8s hang (bad eGPU link) before
    // erroring -- a shorter client timeout would silently report no devices.
    client.getJson(`/api/devices?build=${encodeURIComponent(draft.build)}`, { timeoutMs: 15000 })
      .then((d) => { if (alive) setCatalog((c) => ({ ...c, devices: (d && d.devices) || [] })); })
      .catch(() => { if (alive) setCatalog((c) => ({ ...c, devices: [] })); });
    return () => { alive = false; };
  }, [client, draft.build]);

  // Debounced live command preview (server-side resolution, same endpoint the
  // web UI uses -- CLI and web can never disagree).
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!draft.modelPath || draft.ctx == null || draft.ngl == null) {
      setPreview({ command: '', error: null });
      return;
    }
    previewTimer.current = setTimeout(async () => {
      try {
        setPreview(await client.postJson('/api/preview-command', draftToConfig(draft)));
      } catch (err) {
        setPreview({ command: '', error: err.message });
      }
    }, 400);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [client, draft]);

  useEffect(() => () => { if (previewTimer.current) clearTimeout(previewTimer.current); }, []);

  // Exclusive-input gate: while an editor or an action is in flight the
  // app-level handler (mode switch / quit) must stand down.
  modeGateRef.current = editor !== null || busy !== '';

  async function doLaunch() {
    if (s.server.state !== 'stopped') { flash('A model is already running \u2014 stop it first (x)', false); return; }
    if (!draft.modelPath) { flash('Pick a model first (Enter on the Model field)', false); return; }
    if (draft.rpcEnabled && !workerHost) { flash('RPC is on but Worker host is empty (hw group)', false); return; }
    // With RPC on, /api/start first auto-starts the worker over SSH and
    // waits (~25s) for its RPC port before spawning llama-server -- say so,
    // and give the request enough time that the CLI doesn't report a timeout
    // while the server carries on launching.
    setBusy(draft.rpcEnabled ? `launching (starting RPC worker on ${workerHost} if needed)` : 'launching');
    setStatus(null);
    try {
      await client.postJson('/api/start', draftToConfig(draft), { timeoutMs: draft.rpcEnabled ? 90000 : 30000 });
      flash('Launch requested \u2014 switching to Monitor');
      setTimeout(onLaunched, 250);
    } catch (err) {
      const what = draft.rpcEnabled ? 'Launch failed (RPC worker)' : 'Launch failed';
      flash(`${what}: ${tailLines(err.message, 8)}`, false);
    } finally {
      setBusy('');
    }
  }

  async function doStop() {
    if (s.server.state === 'stopped') { flash('No model running'); return; }
    setBusy('stopping');
    try {
      await client.postJson('/api/stop');
      flash('Stop requested');
    } catch (err) {
      flash(`Stop failed: ${err.message}`, false);
    } finally {
      setBusy('');
    }
  }

  function commitText(field, value) {
    const v = value.trim();
    const spec = NUM_SPECS[field];
    if (spec) {
      if (v === '') {
        setDraft((d) => ({ ...d, [field]: null })); // blank clears an optional number
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.int && !Number.isInteger(n))) {
          flash(`${labelOf(field, draft)} must be a ${spec.int ? 'whole number' : 'number'} between ${spec.min} and ${spec.max}`, false);
          return;
        }
        setDraft((d) => ({ ...d, [field]: spec.int ? n : Math.round(n * 10000) / 10000 }));
      }
    } else {
      setDraft((d) => ({ ...d, [field]: v }));
    }
    setEditor(null);
    setActiveProfile(null); // manual edit detaches from the saved profile
  }

  function toggleField(field) {
    setDraft((d) => {
      const next = { ...d, [field]: !d[field] };
      if (field === 'rpcEnabled' && next.rpcEnabled) {
        // Same as the web toggle: the worker takes the second-node slot.
        next.deviceB = null;
        if (!next.workerHost && defaultWorkerHost) next.workerHost = defaultWorkerHost;
      }
      return next;
    });
    setActiveProfile(null);
  }

  async function saveAs(name) {
    try {
      await saveProfile(client, name, draftToConfig(draft));
      setActiveProfile(name);
      flash(`Saved profile "${name}"`);
    } catch (err) {
      flash(err.message, false);
    }
    setEditor(null);
  }

  // Rename = save the current (visible) draft under the new name, then drop
  // the old entry. If the save lands but the delete fails, both exist and
  // the error says so -- never delete first (that would lose the config).
  async function renameAs(name) {
    const from = activeProfile;
    setEditor(null);
    const to = name.trim();
    if (!to || to === from) return;
    try {
      await saveProfile(client, to, draftToConfig(draft));
      await deleteProfile(client, from);
      setActiveProfile(to);
      flash(`Renamed "${from}" \u2192 "${to}"`);
    } catch (err) {
      flash(err.message, false);
    }
  }

  // Duplicate copies the SAVED profile (the named artifact), not the current
  // draft -- a dirty draft is an edit in progress, not the profile itself.
  async function duplicateAs(name) {
    const from = activeProfile;
    setEditor(null);
    const to = name.trim();
    if (!to) return;
    try {
      const profiles = await listProfiles(client);
      const cfg = profiles[from];
      if (!cfg) { flash(`Profile "${from}" no longer exists`, false); return; }
      await saveProfile(client, to, sanitizeConfig(cfg)); // a web profile's rawCommand doesn't survive the copy
      flash(`Duplicated "${from}" \u2192 "${to}"`);
    } catch (err) {
      flash(err.message, false);
    }
  }

  // Flag reference (PLAN M3): searchable /api/flags overlay; Enter appends
  // the flag's insertText to the raw-args field (the box wins, per the
  // dashboard's philosophy).
  async function openFlags() {
    if (!draft.build) { flash('Pick a build first (Enter on the Build field)', false); return; }
    setBusy('flags');
    try {
      const d = await client.getJson(`/api/flags?build=${encodeURIComponent(draft.build)}`);
      const flags = (d && d.flags) || [];
      if (flags.length === 0) flash(d && d.error ? `Flag list unavailable: ${d.error}` : 'No flags found for this build', false);
      else setEditor({ kind: 'flags', flags });
    } catch (err) {
      flash(`Flag list unavailable: ${err.message}`, false);
    } finally {
      setBusy('');
    }
  }

  function insertFlag(f) {
    const ins = (f && f.insertText) || (f && f.flags);
    setDraft((d) => ({ ...d, argString: d.argString ? `${d.argString} ${ins}` : ins }));
    setActiveProfile(null); // manual edit detaches from the saved profile
    setEditor(null);
    setGroupIdx(GROUPS.findIndex(([g]) => g === 'raw'));
    setFocusIdx(0);
    flash(`Inserted ${f.primaryFlag || f.flags || ''} into raw args`);
  }

  // RPC worker (PLAN M3): start/stop the remote ggml-rpc-server over SSH,
  // exactly like the web Worker box -- the server runs the ssh, the CLI
  // just asks, using the Worker host field as body.worker_ssh. Launching
  // doesn't need this (/api/start auto-starts the worker); it's for
  // starting ahead of time or freeing the laptop afterwards.
  async function toggleWorker() {
    if (!draft.rpcEnabled) { flash('Turn RPC worker on first (hw group)', false); return; }
    const target = workerHost;
    if (!target) { flash('Set the Worker host first (hw group, Enter on Worker host)', false); return; }
    setBusy('worker');
    try {
      const st = await client.postJson('/api/worker/status', { worker_ssh: target });
      const status = st && st.status;
      if (status === 'running') {
        setEditor({ kind: 'confirm', msg: `Stop the RPC worker on ${target}?`, onYes: () => workerAction('stop', target) });
      } else if (status === 'stopped') {
        setEditor({ kind: 'confirm', msg: `Start the RPC worker on ${target}?`, onYes: () => workerAction('start', target) });
      } else {
        flash(`Worker unreachable on ${target} (${(st && st.error) || status || 'offline'})`, false);
      }
    } catch (err) {
      flash(`Worker status failed: ${err.message}`, false);
    } finally {
      setBusy('');
    }
  }

  async function workerAction(action, target) {
    setBusy(`worker ${action} on ${target}`);
    workerBusyRef.current = true;
    setWorkerStatus({ status: action === 'start' ? 'starting' : 'stopping' });
    try {
      // start waits for the worker's RPC port on the server side -- allow it.
      const d = await client.postJson(`/api/worker/${action}`, { worker_ssh: target }, { timeoutMs: 60000 });
      if (d && d.success === false) {
        const e = new Error(d.error || `worker ${action} failed`);
        e.data = d;
        throw e;
      }
      flash(`RPC worker ${action === 'start' ? 'started' : 'stopped'} on ${target}`);
    } catch (err) {
      // The 500 body's error carries the worker's startup log tail; stderr
      // (when present) is the ssh/compose side.
      const stderr = err.data && err.data.stderr ? `\n${tailLines(err.data.stderr, 4)}` : '';
      flash(`Worker ${action} failed: ${tailLines(err.message, 8)}${stderr}  (L: worker logs)`, false);
    } finally {
      workerBusyRef.current = false;
      setWorkerPollNonce((n) => n + 1); // re-poll the badge now
      setBusy('');
    }
  }

  function loadProfile(name) {
    listProfiles(client).then((p) => {
      const prof = p[name];
      if (!prof) return;
      // REPLACE, don't merge with the current draft: a profile is a complete
      // config. Merging would let a minimal profile (e.g. v1-migrated, or
      // `profile save -m X` with no devices) silently inherit the draft's
      // current GPU split and launch a different topology than saved.
      // Only the worker host/transport picks carry over (for a later RPC
      // toggle); rawCommand and unknown keys are dropped.
      setDraft((d) => configToDraft(prof, {
        ...DEFAULT_DRAFT,
        workerHost: d.workerHost || defaultWorkerHost,
        transport: d.transport || DEFAULT_DRAFT.transport,
      }));
      setActiveProfile(name);
      flash(`Loaded profile "${name}"`);
      setEditor(null);
      // Shared "last used" stamp (web's dropdown sorts on it too) --
      // best-effort, never blocks the load.
      markProfileLoaded(client, name).catch(() => {});
    }).catch((err) => flash(err.message, false));
  }

  useInput((input, key) => {
    if (busy) return;
    if (editor) {
      if (editor.kind === 'confirm') {
        if (key.escape || input === 'n' || input === 'q') setEditor(null);
        else if (input === 'y') { const cb = editor.onYes; setEditor(null); if (cb) cb(); }
        return;
      }
      if (key.escape) setEditor(null);
      return; // list/text editors handle their own keys
    }
    const n = fields.length;
    // ink 5 renamed the arrow flags from key.up/down/left/right to
    // key.upArrow/downArrow/leftArrow/rightArrow (ink <=4 used the old names).
    if (key.tab) setGroupIdx((g) => (g + 1) % GROUPS.length), setFocusIdx(0);
    else if (key.leftArrow) setGroupIdx((g) => (g - 1 + GROUPS.length) % GROUPS.length), setFocusIdx(0);
    else if (key.upArrow || (input === 'k' && !key.ctrl)) setFocusIdx((i) => (Math.min(i, n - 1) - 1 + n) % n);
    else if (key.downArrow || (input === 'j' && !key.ctrl)) setFocusIdx((i) => (Math.min(i, n - 1) + 1) % n);
    else if (key.return || key.rightArrow) {
      const [field, , kind] = fields[fi];
      if (field === 'deviceB' && draft.rpcEnabled) flash('GPU B is disabled while RPC is on \u2014 the worker is the second node', false);
      else if (kind === 'toggle') toggleField(field);
      else if (kind === 'list') setEditor({ kind: 'list', field });
      else setEditor({ kind: 'text', field, value: draft[field] == null ? '' : String(draft[field]) });
    } else if (input === 'p' && !key.ctrl) {
      setEditor({ kind: 'name', value: activeProfile || '' });
    } else if (input === 'l' && !key.ctrl) {
      listProfileEntries(client).then((entries) => {
        if (entries.length === 0) flash('No profiles saved yet \u2014 press p to save one', false);
        else setEditor({ kind: 'profiles', entries });
      }).catch((err) => flash(err.message, false));
    } else if (input === 'L' && !key.ctrl) {
      if (!draft.rpcEnabled || !workerHost) flash('Worker logs need RPC on and a Worker host (hw group)', false);
      else setEditor({ kind: 'logs', text: '', error: null });
    } else if (input === 'd' && !key.ctrl && activeProfile) {
      setEditor({
        kind: 'confirm',
        msg: `Delete profile "${activeProfile}"?`,
        onYes: () => deleteProfile(client, activeProfile)
          .then(() => { setActiveProfile(null); flash(`Deleted "${activeProfile}"`); })
          .catch((err) => flash(err.message, false)),
      });
    } else if (input === 'r' && !key.ctrl && activeProfile) {
      setEditor({ kind: 'name', value: activeProfile, label: `Rename profile "${activeProfile}" to`, onSubmit: renameAs });
    } else if (input === 'c' && !key.ctrl && activeProfile) {
      setEditor({ kind: 'name', value: `${activeProfile}-copy`, label: 'Duplicate profile as', onSubmit: duplicateAs });
    } else if (input === '/' && !key.ctrl) openFlags();
    else if (input === 'w' && !key.ctrl) toggleWorker();
    else if (input === 'b' && !key.ctrl) doLaunch();
    else if (input === 'x' && !key.ctrl) doStop();
  });

  // ---- list picker options per list field ----
  function listOptions(field) {
    switch (field) {
      case 'modelPath': {
        const items = catalog.models.map((mm) => ({ label: mm.name, hint: `${mm.size} GB \u00B7 ${mm.source}`, value: mm.path }));
        if (draft.modelPath && !items.some((ii) => ii.value === draft.modelPath)) {
          items.unshift({ label: draft.modelPath.split('/').pop(), hint: '(current)', value: draft.modelPath });
        }
        return items;
      }
      case 'build':
        return catalog.builds.map((bb) => ({ label: bb.label, hint: bb.id, value: bb.id }));
      case 'deviceA':
      case 'deviceB': {
        const items = [{ label: 'None', hint: '', value: null }];
        for (const dd of catalog.devices) {
          items.push({ label: dd.id, hint: `${dd.description} \u00B7 ${(dd.totalMib / 1024).toFixed(0)} GB`, value: dd.id });
        }
        if (draft[field] && !items.some((ii) => ii.value === draft[field])) {
          items.unshift({ label: draft[field], hint: '(current, manual)', value: draft[field] });
        }
        return items;
      }
      case 'cacheK':
      case 'cacheV': {
        const items = [{ label: '(none \u2014 f16 default)', hint: '', value: '' },
          ...KV_QUANTS.map(([q, hint]) => ({ label: q, hint, value: q }))];
        const cur = draft[field] || '';
        if (cur && !items.some((ii) => ii.value === cur)) items.splice(1, 0, { label: cur, hint: '(current)', value: cur });
        return items;
      }
      case 'specType': {
        const items = [{ label: '(none)', hint: 'no speculative decoding', value: '' },
          ...SPEC_TYPES.map((q) => ({ label: q, hint: '', value: q }))];
        const cur = draft.specType || '';
        if (cur && !items.some((ii) => ii.value === cur)) items.splice(1, 0, { label: cur, hint: '(current)', value: cur });
        return items;
      }
      case 'transport':
        return TRANSPORTS.map(([t, hint]) => ({ label: t, hint, value: t }));
      case 'loadMode': {
        const items = [{ label: '(none \u2014 auto)', hint: '', value: '' },
          ...LOAD_MODES.map((q) => ({ label: q, hint: '', value: q }))];
        if (draft.loadMode && !items.some((ii) => ii.value === draft.loadMode)) {
          items.splice(1, 0, { label: draft.loadMode, hint: '(current)', value: draft.loadMode });
        }
        return items;
      }
      default:
        return [];
    }
  }

  // ---- field value display ----
  function displayValue(field) {
    const kind = kindOf(field);
    const v = draft[field];
    switch (field) {
      case 'modelPath': {
        if (!v) return h(Text, { color: 'yellow' }, '(none \u2014 press Enter to pick)');
        const known = catalog.models.find((mm) => mm.path === v);
        if (known) {
          return h(Box, null,
            h(Text, null, known.name),
            h(Text, { dimColor: true }, `  ${known.size} GB \u00B7 ${known.source}`));
        }
        // Not in the scan (pasted path): show basename + a truncated path so
        // a 110-char HF snapshot path doesn't wrap the row on an 80-col term.
        const maxPath = Math.max(20, cols - 35);
        const shown = v.length > maxPath ? '\u2026' + v.slice(v.length - maxPath + 1) : v;
        return h(Box, null, h(Text, null, v.split('/').pop()), h(Text, { dimColor: true }, `  ${shown}`));
      }
      case 'build': {
        const b = catalog.builds.find((bb) => bb.id === v);
        return b
          ? h(Box, null, h(Text, null, b.label), h(Text, { dimColor: true }, `  [${b.id}]`))
          : h(Text, { color: v ? undefined : 'yellow' }, v || '(none \u2014 press Enter to pick)');
      }
      case 'deviceB':
        if (draft.rpcEnabled) return h(Text, { dimColor: true }, 'None  (disabled — RPC worker is the second node)');
      // falls through
      case 'deviceA': {
        const dv = catalog.devices.find((dd) => dd.id === v);
        return v
          ? h(Box, null,
            h(Text, null, v),
            dv ? h(Text, { dimColor: true }, `  ${dv.description}`) : h(Text, { dimColor: true }, '  (manual)'))
          : h(Text, { dimColor: true }, 'None');
      }
      case 'mmprojOffload': {
        // The stored flag is llama.cpp's own GPU-offload flag (true/unset =
        // GPU, its default) -- the field is labeled "-> system RAM" instead,
        // so what's shown here is the inverse: on/green means "opted into
        // system RAM", off/gray means the (default) GPU placement.
        const ram = v === false;
        return h(Text, { color: ram ? 'green' : 'gray' }, ram ? 'on' : 'off');
      }
      case 'rpcEnabled': {
        if (!v) return h(Text, { color: 'gray' }, 'off');
        const ws = workerStatus && workerStatus.status;
        const badge = {
          running: ['RUNNING', 'green'], stopped: ['STOPPED', 'yellow'], offline: ['OFFLINE', 'red'],
          error: ['ERROR', 'red'], starting: ['STARTING…', 'yellow'], stopping: ['STOPPING…', 'yellow'],
        }[ws] || [workerHost ? 'checking…' : 'no host', 'gray'];
        const err = workerStatus && workerStatus.error && (ws === 'offline' || ws === 'error')
          ? ` ${String(workerStatus.error).split('\n')[0].slice(0, Math.max(10, cols - 45))}` : '';
        return h(Box, null,
          h(Text, { color: 'green' }, 'on  '),
          h(Text, { color: badge[1], bold: ws === 'running' }, `[${badge[0]}]`),
          err ? h(Text, { dimColor: true }, err) : null);
      }
      case 'workerHost':
        return h(Text, { color: v ? undefined : 'gray', dimColor: !draft.rpcEnabled }, v || '(none — ssh alias or user@host)');
      case 'transport':
        return h(Text, null, v || DEFAULT_DRAFT.transport);
      case 'tensorSplit': {
        if (v == null) return h(Text, { color: 'gray' }, '(unset)');
        // The split only applies with a second node (GPU B or the worker).
        const active = draft.rpcEnabled || (draft.deviceB && draft.deviceB !== draft.deviceA);
        return h(Box, null, h(Text, null, String(v)), h(Text, { dimColor: true }, `  ${splitText(draft)}${active ? '' : ' (unused — no second node)'}`));
      }
      case 'fa':
      case 'jinja':
      case 'mmprojEnabled':
      case 'reasoningPreserve':
        return h(Text, { color: v ? 'green' : 'gray' }, v ? 'on' : 'off');
      case 'argString':
      case 'chatTemplateFile':
      case 'mmprojPath':
      case 'specDraftModel':
        return h(Text, { color: v ? undefined : 'gray' }, v || '(none)');
      default:
        if (kind === 'num' || kind === 'float') return h(Text, { color: v == null ? 'gray' : undefined }, v == null ? '(unset)' : String(v));
        return h(Text, null, String(v ?? ''));
    }
  }

  const running = s.server.state !== 'stopped';
  const offlineWarn = s.conn !== 'live';

  // Mouse click hit-testing for the group-tab row and the field rows below
  // it. This row math MUST mirror the JSX at the bottom of this component
  // exactly (title row, conditional running-warning row, blank spacer,
  // conditional offline-warning row, group-tab row, then one row per field)
  // -- any row added/removed above formRows there needs the same edit here.
  // Suspend the terminal's mouse tracking while a keyboard editor is open:
  // the text fields need the terminal's OWN middle-click paste (primary
  // selection), and with tracking on the terminal would report that
  // middle-click as an SGR sequence that ink-text-input inserts verbatim
  // (see mouse.js's gate comment). Confirm prompts are excluded -- they
  // take only y/n/Esc, no text, so nothing there can be corrupted.
  const mouseGated = editor !== null && editor.kind !== 'confirm';
  useEffect(() => {
    setMouseGate(mouseGated);
    return () => setMouseGate(false);
  }, [mouseGated]);

  const groupTabsRow = APP_HEADER_ROWS + 1 /* title */ + (running ? 1 : 0) + 1 /* blank */ + (offlineWarn ? 1 : 0) + 1;
  const fieldsStartRow = groupTabsRow + 1;
  useMouseClicks(true, ({ x, y }) => {
    // A list/text/name/profiles/flags editor owns the keyboard already (see
    // the useInput guard above) -- a confirm prompt is the one editor kind
    // still safe to click past, since y/n/Esc are its only inputs and none
    // of them live in the field list or group tabs.
    if (busy || (editor && editor.kind !== 'confirm')) return;
    if (y === groupTabsRow) {
      let col = 1;
      for (let i = 0; i < GROUPS.length; i++) {
        const len = 2 + GROUPS[i][0].length; // ` ${marker}${g}` -- marker is 1 col
        if (x >= col && x < col + len) { setGroupIdx(i); setFocusIdx(0); return; }
        col += len;
      }
      return;
    }
    const i = y - fieldsStartRow;
    if (i >= 0 && i < fields.length) {
      setFocusIdx(i);
      const [field, , kind] = fields[i];
      // Toggles are the one field kind that IS a button in the literal
      // sense -- a click both focuses and flips it, same as Enter would.
      // List/text/num fields only move focus; opening their editor on a
      // single click would be surprising (and for list fields, pop a picker
      // over content the user may have just been trying to look at).
      if (kind === 'toggle') toggleField(field);
    }
  });

  // Keep the stored focus inside the (possibly shrunk) field list.
  useEffect(() => { if (focusIdx !== fi) setFocusIdx(fi); }, [focusIdx, fi]);

  const groupTabs = GROUPS.map(([g], i) =>
    h(Text, { key: g, bold: i === groupIdx, color: i === groupIdx ? 'cyan' : undefined, dimColor: i !== groupIdx },
      ` ${i === groupIdx ? '\u258F' : '\u25A1'}${g}`));

  const formRows = fields.map(([field], i) => {
    const focused = i === fi && !editor;
    return h(Box, { key: field },
      h(Text, null,
        focused ? h(Text, { bold: true, color: 'green' }, '\u203A ') : '  ',
        h(Text, { bold: focused, dimColor: !focused }, pad(labelOf(field, draft), 15)),
      ),
      displayValue(field),
    );
  });

  let editorView = null;
  if (editor && editor.kind === 'list') {
    editorView = h(FuzzyList, {
      title: `Select ${labelOf(editor.field, draft)}`,
      items: listOptions(editor.field),
      onSelect: (it) => { setDraft((d) => ({ ...d, [editor.field]: it.value })); setEditor(null); setActiveProfile(null); },
      onCancel: () => setEditor(null),
    });
  } else if (editor && editor.kind === 'text') {
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, `${labelOf(editor.field, draft)} (Enter to commit, Esc to cancel):`),
      h(TextInput, {
        value: editor.value,
        onChange: (v) => setEditor((e) => ({ ...e, value: v })),
        onSubmit: (v) => commitText(editor.field, v),
      }),
    );
  } else if (editor && editor.kind === 'name') {
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, `${editor.label || 'Profile name'} (Enter to save, Esc to cancel):`),
      h(TextInput, {
        value: editor.value,
        onChange: (v) => setEditor((e) => ({ ...e, value: v })),
        onSubmit: editor.onSubmit || saveAs,
      }),
    );
  } else if (editor && editor.kind === 'flags') {
    editorView = h(FuzzyList, {
      title: `Flags \u00B7 ${draft.build}  (${editor.flags.length})`,
      items: editor.flags.map((f) => ({
        label: f.flags,
        hint: (f.description || '').length > 64 ? `${f.description.slice(0, 63)}\u2026` : (f.description || ''),
        value: f,
      })),
      onSelect: (it) => insertFlag(it.value),
      onCancel: () => setEditor(null),
    });
  } else if (editor && editor.kind === 'profiles') {
    // Most-recently-used first (listProfileEntries), tagged RPC/Local like
    // the web dropdown.
    editorView = h(FuzzyList, {
      title: 'Load profile  (most recently used first)',
      items: editor.entries.map(({ name, config }) => ({
        label: name,
        hint: `${profileTag(config)} · ${config.modelPath ? config.modelPath.split('/').pop() : '(no model)'}`,
        value: name,
      })),
      onSelect: (it) => loadProfile(it.value),
      onCancel: () => setEditor(null),
    });
  } else if (editor && editor.kind === 'logs') {
    // Fixed-height tail so the 3s refresh never changes the screen height.
    const LOG_ROWS = 15;
    const maxW = Math.max(20, cols - 4);
    const lines = (editor.error || editor.text || 'fetching…').replace(/\s+$/, '').split('\n').slice(-LOG_ROWS);
    while (lines.length < LOG_ROWS) lines.unshift(' ');
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { bold: true }, `Worker logs · ${workerHost}  `, h(Text, { dimColor: true }, '(refreshes every 3s · Esc closes)')),
      ...lines.map((ln, i) => h(Text, { key: i, dimColor: !editor.error, color: editor.error ? 'red' : undefined },
        ` ${ln.length > maxW ? ln.slice(0, maxW - 1) + '…' : ln}`)),
    );
  } else if (editor && editor.kind === 'confirm') {
    editorView = h(Box, null,
      h(Text, { color: 'yellow' }, `${editor.msg} `),
      h(Text, { bold: true }, '[y/N]'),
    );
  }

  return h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { bold: true, color: 'blue' }, 'LAUNCH'),
      activeProfile ? h(Text, { dimColor: true }, `  profile: ${activeProfile}`) : null,
      !activeProfile && s.server.launchConfig
        ? h(Text, { dimColor: true }, cols < 100 ? '  (current run)' : '  (prefilled from current run)')
        : null,
    ),
    running
      ? h(Box, null,
        h(Text, { color: 'yellow' }, cols < 100
          ? ' \u00B7 model running \u2014 stop with x first'
          : ' \u00B7 model running \u2014 stop with x before launching'))
      : null,
    h(Text, null, ' '),

    offlineWarn
      ? h(Text, { color: 'red' }, 'dashboard offline \u2014 catalog and preview unavailable (reconnecting\u2026)')
      : null,

    h(Box, null, ...groupTabs),
    h(Box, { flexDirection: 'column' }, ...formRows),
    h(Text, null, ' '),

    editorView,
    h(Text, null, ' '),

    !editor
      ? h(Box, { flexDirection: 'column' },
        h(Text, { dimColor: true }, 'command:'),
        preview.error
          ? h(Text, { color: 'red' }, `  ${preview.error}`)
          : preview.command
            ? h(Text, { wrap: 'wrap' }, `  ${preview.command}`)
            : h(Text, { dimColor: true }, '  (set model, ctx and ngl to preview)'),
      )
      : null,

    status
      ? h(Box, null, h(Text, { color: status.ok ? 'green' : 'red' }, ` ${status.text}`))
      : busy
        ? h(Box, null, h(Text, { color: 'yellow' }, ` ${busy}\u2026`))
        : null,

    // Responsive: the full set is 129 cols wide and wraps below that (a
    // wrapping keymap bar is exactly the layout thrash the monitor view was
    // fixed for); the narrow set is 76 cols so it fits an 80-col terminal --
    // no room for L there. The '?' overlay has the complete map either way.
    h(KeymapBar, {
      hints: cols >= 132
        ? [
          ['\u2191/\u2193', 'field'], ['tab/\u2190', 'group'], ['Enter', 'edit'],
          ['p', 'save'], ['l', 'load'], ['d', 'del'], ['r', 'rename'], ['c', 'dup'],
          ['/', 'flags'], ['w', 'worker'], ['L', 'wlogs'], ['b', 'launch'], ['x', 'stop'],
        ]
        : [
          ['p', 'save'], ['l', 'load'], ['r', 'rename'], ['c', 'dup'],
          ['/', 'flags'], ['w', 'worker'], ['b', 'launch'], ['x', 'stop'],
        ],
    }),
  );
}
