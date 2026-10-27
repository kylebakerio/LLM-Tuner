import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { h } from '../h.js';
import { FuzzyList } from '../components/fuzzylist.js';
import { KeymapBar } from '../components/statusbar.js';
import { useAppStore } from '../state.js';
import { RunningLine, RunningActions, ProfileList, LaunchConfirm, listTop } from '../components/launchviews.js';
import { listProfileState, saveProfile, deleteProfile, markProfileLoaded } from '../profiles.js';
import {
  DEFAULT_DRAFT, TRANSPORTS, VERBOSITY_MIN, configToDraft, draftToConfig,
  convertLegacyConfig, needsDeviceConversion, mergeCatalog, sharePercents, suggestShares,
  hasEnabledWorker, pollableWorkers, findBackend,
  toggleDeviceAt, adjustShareAt, setShareAt, moveDeviceAt, cycleBackendAt,
  unnamedDeviceNotes, uniqueWarnings, splitProblem, configSplitMode, setSplitMode, describeSplitMode, repointNotes,
} from '../launchconfig.js';
import {
  profileRow, profileListRows, availabilityCounts, filterRows, profileLaunchPlan, normalizeBusy, isCardBusyError, isRunningError,
  isUnavailableHereError, availabilityFromError, startBody, devicesListingNote,
  runningSummary, launchRisks, planCards, planSplit, strataLaunchConfig,
} from '../launchplan.js';
import {
  STRATA_FIELDS, strataDraft, strataDraftToConfig, commitStrataField, fieldKind as strataKind, fieldLabel as strataLabel,
  fieldChoices as strataChoices, baseEntry, displayStrataValue, installLine, baseItems,
} from '../strataform.js';
import { normalizeTopology, topologyFromCatalog, cardOfId, deviceLabel } from '../topology.js';
import { pad, modelName, isLaunchableModel } from '../format.js';
import { useMouseClicks, setMouseGate, APP_HEADER_ROWS } from '../mouse.js';

// Launch mode is profile-first. Three views share the two header lines (what
// the dashboard's server is running, and the stop/restart keys):
//   list    -- the saved profiles, one line each: the ones this machine can
//              run first, the rest dimmed at the bottom (u hides them) with
//              the server's reason; Enter reviews one
//   confirm -- the resolved command and cards for one launch, busy-card and
//              stop-first warnings, then one key to launch
//   editor  -- the field-by-field config form (the old first screen), reached
//              with e / n; it is also where Launch opens when no profile has
//              been saved yet
//   strata  -- the Strata-engine form (strataform.js): a base config file of a
//              Strata install plus overrides, reached with e on a Strata
//              profile or N (a new one); 2026-10-17
// Every launch -- a profile, the editor's draft, a restart that hit a busy
// card -- goes through the confirm view, so there is one path to /api/start.
//
// Nothing here knows what cards the machine has: which profiles can run, where
// a launch sits and what each card is called come from the server (the
// `availability` and `topology` sent with /api/profiles and /api/devices;
// topology.js). A server that sends neither gets the list as it always was.

// The full launch-config surface, grouped (mirrors PLAN §6.3 and the server's
// buildLlamaArgs -- every key here is one buildLlamaArgs reads). Field kinds:
//   list   -> FuzzyList picker (Enter)
//   num    -> integer text editor
//   float  -> decimal text editor
//   text   -> free text
//   toggle -> Enter flips on/off
//   action -> Enter runs it
//   split  -> Enter switches the split mode (layer <-> tensor)
// The hw group's device rows are generated (see visibleFields).
const GROUPS = [
  ['core', [
    ['modelPath', 'Model', 'list'],
    ['build', 'Build', 'list'],
    ['ctx', 'Context', 'num'],
    ['ngl', 'nGl', 'num'],
    ['port', 'Port', 'num'],
  ]],
  // hw: one row per device -- every card this build sees plus every
  // configured RPC worker, in -dev order (the draft's `devices` merged with
  // the /api/devices catalog, launchconfig.js mergeCatalog) -- then Suggest
  // split and Split mode (two or more enabled) and Transport (a worker
  // enabled).
  ['hw', [
    ['suggest', 'Suggest split', 'action'],
    ['splitMode', 'Split mode', 'split'],
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
    ['specDraftDevice', 'Draft device', 'list'],
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
    ['mmprojOffload', 'Offload to system RAM', 'toggle'],
    ['loadMode', 'Load mode', 'list'],
    ['verbosity', 'Verbosity', 'num'],
  ]],
  ['raw', [
    ['argString', 'Raw args', 'text'],
  ]],
];
const HW_GROUP = GROUPS.findIndex(([g]) => g === 'hw');

// The draft shape (DEFAULT_DRAFT), its launch-config mapping, the device-row
// merge/edits and profile sanitizing live in ../launchconfig.js (pure,
// unit-tested). Every request body leaves this file through draftToConfig --
// never the raw draft.

const WORKER_STATUS_POLL_MS = 5000;
const WORKER_LOGS_POLL_MS = 3000;
const SHARE_STEP = 5;
// After /api/stop the old llama-server takes a moment to exit (SIGTERM, then
// SIGKILL after 3s) and /api/start answers 400 "Running" until it has -- a
// stop-then-start (switching profiles, restart) retries for this long.
const START_RETRY_MS = 20000;
const START_RETRY_GAP_MS = 400;
// Rows around the profile list (app header 3, Launch header 2, list header 3,
// range 1, detail 3, prompt 2, key hints 2, one spare so the frame never
// fills the terminal) -- the list gets what is left.
const LIST_CHROME_ROWS = 17;
// Rows around the confirm panel: app header 3, Launch header 2, status line,
// key hints, one spare.
const CONFIRM_CHROME_ROWS = 8;
// placement / splitMode / status: what a server from 2026-10-12 on says about the resolved launch (null from an older one).
const EMPTY_PREVIEW = { loading: false, command: '', error: null, warnings: [], devices: null, busy: [], placement: null, splitMode: null, status: null };

const WORKER_BADGES = {
  running: ['RUNNING', 'green'], stopped: ['STOPPED', 'yellow'], offline: ['OFFLINE', 'red'],
  error: ['ERROR', 'red'], starting: ['STARTING…', 'yellow'], stopping: ['STOPPING…', 'yellow'],
  checking: ['checking…', 'gray'],
};

const NUM_SPECS = {
  ctx: { min: 1, max: 1e9, int: true },
  ngl: { min: 0, max: 1e6, int: true },
  port: { min: 1, max: 65535, int: true },
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
// 2026-10-17: + ngram-mod and draft-mtp,ngram-mod -- the stack every
// benchmark 27B config runs (the web lists ngram-mod; here it was only kept as
// "(current)" when a loaded profile already had it).
const SPEC_TYPES = [
  'draft-mtp',
  'draft-mtp,ngram-mod',
  'ngram-mod',
  'ngram-simple',
  'ngram-map-k',
  'ngram-map-k4v',
  'draft-mtp,ngram-simple',
  'ngram-simple,ngram-map-k',
  'ngram-simple,ngram-map-k4v',
  'draft-mtp,ngram-simple,ngram-map-k4v',
];
const LOAD_MODES = ['mmap', 'mlock', 'none'];
// Speculative strategies that need --spec-draft-model (draft-mtp and ngram-*
// don't).
const DRAFT_MODEL_STRATEGIES = ['draft-simple', 'draft-eagle3', 'draft-dflash', 'draft-dspark'];

function kindOf(field) {
  for (const [, fields] of GROUPS) {
    const f = fields.find((x) => x[0] === field);
    if (f) return f[2];
  }
  return 'text';
}

// Device row index of a generated hw field ('dev:3' -> 3), else -1.
function deviceIndex(field) {
  return typeof field === 'string' && field.startsWith('dev:') ? Number(field.slice(4)) : -1;
}

// The rows a group actually shows. hw: one row per device, then Suggest split
// and Split mode (two or more enabled -- with one device there is nothing to
// split) and Transport (only sent while a worker is enabled).
// The mouse hit-test and the up/down wrap both read this same list, so they
// can't drift.
function visibleFields(groupIdx, draft, rows) {
  const [g, fields] = GROUPS[groupIdx];
  // Draft model: only for the strategies that load a separate draft model.
  if (g === 'spec') {
    const needsModel = String(draft.specType || '').split(',').some((t) => DRAFT_MODEL_STRATEGIES.includes(t.trim()));
    return needsModel ? fields : fields.filter(([field]) => field !== 'specDraftModel');
  }
  if (g !== 'hw') return fields;
  const out = rows.length > 0
    ? rows.map((r, i) => [`dev:${i}`, `#${i + 1} ${r.entry.worker ? 'rpc' : 'local'}`, 'device'])
    : [['devices', 'Devices', 'info']];
  const field = (name) => fields.find(([f]) => f === name);
  if (rows.filter((r) => r.entry.enabled).length >= 2) out.push(field('suggest'), field('splitMode'));
  if (hasEnabledWorker(draft.devices)) out.push(field('transport'));
  return out;
}

// Last `n` lines of a (possibly multi-line) server error -- the worker
// start failure carries its startup log tail.
function tailLines(text, n) {
  const lines = String(text || '').trim().split('\n');
  return lines.slice(-n).join('\n');
}

const gb = (mib) => (Number.isFinite(mib) ? (mib / 1024).toFixed(1) : '--');

export function Launch({ appStore, client, serverUrl, modeGateRef, onLaunched, visible = true, viewRef }) {
  const { stdout } = useStdout();
  const cols = (stdout && stdout.columns) || 80;
  const termRows = (stdout && stdout.rows) || 24;
  const s = useAppStore(appStore);
  // 'loading' until the profile list first answers, then 'list' (or 'editor'
  // when nothing is saved yet); 'confirm' while one launch is under review.
  const [view, setView] = useState('loading');
  const [entries, setEntries] = useState([]); // listProfileState().entries: most recently used first
  // /api/profiles `availability` ({ name: { status, reason, placement } }):
  // can each profile run on this machine. null = the server sent none.
  const [availability, setAvailability] = useState(null);
  const [hideUnavailable, setHideUnavailable] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  // The launch under review in the confirm view:
  //   { id, kind: 'profile'|'draft'|'restart', origin: 'list'|'editor', name, row (profileRow),
  //     config (the /api/start body, null while a legacy profile converts), notes, problem,
  //     preview: { loading, command, error, warnings, devices, busy },
  //     step: 'review'|'risk', late (a 409 CARD_BUSY arrived), lateMessage,
  //     override (O was pressed on a profile this machine can't run, or the
  //     dashboard refused the launch for that reason: `refused`) }
  const [pending, setPending] = useState(null);
  const pendingSeq = useRef(0);
  const [strataConfigs, setStrataConfigs] = useState(null);
  // The one directory an older server's Strata list covers (no `installs` in
  // its answer); null once the list spans every configured install.
  const [strataScope, setStrataScope] = useState(null);
  // /api/strata/configs `installs` (label, launcher, thpOff), for the Strata editor's install line and picker.
  const [strataInstalls, setStrataInstalls] = useState([]);
  // The Strata editor: its draft (strataform.js), the profile config it was loaded from (kept keys ride along on save),
  // the focused row, and the live command preview.
  const [sDraft, setSDraft] = useState(strataDraft({}));
  const [sOrig, setSOrig] = useState({ engine: 'strata' });
  const [sFocus, setSFocus] = useState(0);
  const [sPreview, setSPreview] = useState({ command: '', error: null, warnings: [] });
  const [draft, setDraft] = useState({ ...DEFAULT_DRAFT });
  const [groupIdx, setGroupIdx] = useState(0);
  const [focusIdx, setFocusIdx] = useState(0);
  const [editor, setEditor] = useState(null);
  // editor (an overlay, in any view): { kind: 'list'|'text'|'name'|'confirm'|'flags'|'logs', field?, value?, msg?, onYes?, label?, onSubmit?, flags?, worker? }
  // devicesNote / devicesError: what the dashboard said about that listing (served from its cache; no listing at all).
  const [catalog, setCatalog] = useState({ models: [], allModels: [], builds: [], devices: [], cards: [], cardsBuild: '', topology: null, workers: [], devicesNote: '', devicesError: '' });
  const [preview, setPreview] = useState({ command: '', error: null, warnings: [] });
  // Notes from converting a config without `devices` (the server preview's
  // warnings) -- shown with the preview's own until the next load or edit.
  const [restoreNotes, setRestoreNotes] = useState([]);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  // activeProfile: the saved profile the draft still equals (any edit clears
  // it); baseProfile: the one it was loaded from, kept through edits so the
  // save prompt offers that name back.
  const [activeProfile, setActiveProfile] = useState(null);
  const [baseProfile, setBaseProfile] = useState(null);
  // worker name -> { status: 'running'|'stopped'|'offline'|'error'|'checking'|..., error? }
  const [workerStatus, setWorkerStatus] = useState({});
  const [workerPollNonce, setWorkerPollNonce] = useState(0);
  const previewTimer = useRef(null);
  // Does this server know the `splitMode` launch-config field? It says so by
  // answering a preview with one (2026-10-12 on). Until it has, the split
  // mode is written where every server reads it: the raw args.
  const splitFieldRef = useRef(false);
  const noteSplitField = (res) => { if (res && Object.prototype.hasOwnProperty.call(res, 'splitMode')) splitFieldRef.current = true; };
  const prefilledRef = useRef(false);
  const workerBusyRef = useRef(false);

  // Device rows: the draft's list merged with this build's cards and the
  // configured workers. Materialized back into the draft (effect below) so
  // what the table shows is exactly what gets sent.
  // Only the cards fetched for THIS build: a profile loaded for another build
  // must not be merged against the previous build's list while the new one is
  // still on its way (one card is ROCm0 in one build, Vulkan1 in another --
  // the merge would re-point the saved id to the wrong backend and keep it).
  const cards = catalog.cardsBuild === draft.build ? catalog.cards : [];
  // The machine as the server describes it (state.js `topology`), and the
  // same cards with THIS build's ids for the editor's rows.
  const topology = s.topology;
  const buildTopology = (catalog.cardsBuild === draft.build && catalog.topology) || topology;
  // `reference`: the machine's fullest listing says which of several
  // identical cards a saved id means when this build does not have that id.
  const merge = (devices) => mergeCatalog(devices, cards, catalog.workers, { reference: topology });
  const rows = merge(draft.devices);
  const rowsKey = JSON.stringify(rows.map((r) => r.entry));
  const percents = sharePercents(rows.map((r) => r.entry));
  // Shares that don't total 100 (or are only partly set) render red, and
  // openDraftConfirm refuses to go on (same rule as the web, launchconfig.js).
  const splitBad = !!splitProblem(rows.map((r) => r.entry));
  const fields = visibleFields(groupIdx, draft, rows);
  const fi = Math.min(focusIdx, fields.length - 1); // list can shrink (a worker disabled hides transport)
  const focusedDevice = fields[fi] ? deviceIndex(fields[fi][0]) : -1;
  const flash = (text, ok = true) => setStatus({ text, ok });

  // Profile rows for the list view (and the filter over them): runnable
  // profiles first, the ones this machine can't run last (or left out).
  const profileRows = profileListRows(entries, { models: catalog.allModels, strata: strataConfigs, strataScope, availability, topology });
  const counts = availabilityCounts(profileRows);
  const listable = (list) => (hideUnavailable ? list.filter((r) => r.runnable) : list);
  const shown = filterRows(listable(profileRows), filter);
  const selIdx = Math.min(sel, Math.max(shown.length - 1, 0));
  const listHeight = Math.max(3, Math.min(Math.max(profileRows.length, 3), termRows - LIST_CHROME_ROWS - (s.conn !== 'live' ? 1 : 0)));
  const run = runningSummary(s.server, s.modelUpSince, Date.now(), topology);

  // The saved profiles: on mount and again whenever the stream (re)connects.
  // The first answer picks the opening view; later ones only refresh the rows.
  // Returns listProfileState()'s { entries, availability, topology }.
  async function refreshProfiles() {
    try {
      const st = await listProfileState(client);
      setEntries(st.entries);
      setAvailability(st.availability);
      if (st.topology) appStore.onTopology(st.topology);
      setLoadError(null);
      return st;
    } catch (err) {
      setLoadError(err.message);
      return null;
    }
  }
  useEffect(() => {
    let alive = true;
    refreshProfiles().then((st) => {
      if (alive) setView((v) => (v === 'loading' ? (st && st.entries.length === 0 ? 'editor' : 'list') : v));
    });
    return () => { alive = false; };
  }, [client, s.conn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Strata base configs, for the missing-file marker on Strata profiles --
  // only asked for when a saved profile uses that engine. The list covers
  // every Strata install the dashboard is configured with (`installs`); an
  // older server lists one directory (`dir`) and nothing outside it.
  const hasStrata = entries.some((e) => e.config && e.config.engine === 'strata');
  const strataView = view === 'strata';
  useEffect(() => {
    if (!hasStrata && !strataView) return undefined;
    let alive = true;
    client.getJson('/api/strata/configs')
      .then((d) => {
        if (!alive || !d || !Array.isArray(d.configs)) return;
        setStrataConfigs(d.configs.filter((c) => c && c.path));
        setStrataScope(!Array.isArray(d.installs) && typeof d.dir === 'string' && d.dir ? d.dir : null);
        setStrataInstalls(Array.isArray(d.installs) ? d.installs : []);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [client, hasStrata, strataView]);

  useEffect(() => {
    if (rowsKey !== JSON.stringify(draft.devices)) {
      // A row moved to one of several identical cards: said once, with the
      // other restore notes, since after this the draft simply holds the new id.
      const moved = repointNotes(rows, (e) => deviceLabel(buildTopology, e));
      if (moved.length) setRestoreNotes((n) => uniqueWarnings(n, moved));
      setDraft((d) => ({ ...d, devices: merge(d.devices).map((r) => r.entry) }));
    }
  }, [rowsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply a row edit to the merged device list.
  function editDevices(fn) {
    setDraft((d) => ({ ...d, devices: fn(merge(d.devices).map((r) => r.entry)) }));
    setRestoreNotes([]); // the table is the user's now, not the restored config
    setActiveProfile(null); // manual edit detaches from the saved profile
  }

  // Configured workers from GET /api/worker/config -- used until (or when an
  // older server doesn't return them from) /api/devices.
  useEffect(() => {
    let alive = true;
    client.getJson('/api/worker/config')
      .then((d) => {
        if (!alive || !d || !Array.isArray(d.workers)) return;
        setCatalog((c) => (c.workers.length ? c : { ...c, workers: d.workers }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [client]);

  // Worker status badges: polled by the server over SSH every 5s, only for
  // enabled worker rows, only while the config editor is the screen up (and
  // while this mode is mounted -- app.js unmounts Launch on a mode switch,
  // which runs the cleanup). Skips a worker whose
  // previous call hasn't come back (an unreachable host can take the full ssh
  // timeout) and every worker while a start/stop is in flight.
  const pollNames = pollableWorkers(draft.devices).join('\n');
  useEffect(() => {
    const names = pollNames ? pollNames.split('\n') : [];
    if (names.length === 0 || s.conn !== 'live' || view !== 'editor') { setWorkerStatus({}); return undefined; }
    let alive = true;
    const inFlight = new Set();
    setWorkerStatus((ws) => Object.fromEntries(names.map((n) => [n, ws[n] || { status: 'checking' }])));
    const tick = () => {
      if (workerBusyRef.current) return;
      for (const name of names) {
        if (inFlight.has(name)) continue;
        inFlight.add(name);
        client.postJson('/api/worker/status', { worker: name }, { timeoutMs: 15000 })
          .then((st) => { if (alive) setWorkerStatus((ws) => ({ ...ws, [name]: { status: (st && st.status) || 'offline', error: (st && st.error) || null } })); })
          .catch((err) => { if (alive) setWorkerStatus((ws) => ({ ...ws, [name]: { status: 'error', error: err.message } })); })
          .finally(() => { inFlight.delete(name); });
      }
    };
    tick();
    const iv = setInterval(tick, WORKER_STATUS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [client, pollNames, s.conn, workerPollNonce, view]);

  // Worker logs overlay: refetch the last 50 lines every 3s while it's open.
  const logsWorker = editor && editor.kind === 'logs' ? editor.worker : '';
  useEffect(() => {
    if (!logsWorker) return undefined;
    let alive = true;
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      client.postJson('/api/worker/logs', { worker: logsWorker }, { timeoutMs: 15000 })
        .then((d) => { if (alive) setEditor((e) => (e && e.kind === 'logs' ? { ...e, text: (d && d.logs) || 'No logs returned.', error: null } : e)); })
        .catch((err) => { if (alive) setEditor((e) => (e && e.kind === 'logs' ? { ...e, error: `Failed to fetch logs: ${err.message}` } : e)); })
        .finally(() => { inFlight = false; });
    };
    tick();
    const iv = setInterval(tick, WORKER_LOGS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [client, logsWorker]);

  // Load model + build catalogs.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [allModels, builds] = await Promise.all([
        client.getJson('/api/models').catch(() => []),
        client.getJson('/api/builds').catch(() => ({ builds: [] })),
      ]);
      // models only: /api/models also lists mmproj files and draft heads (each model entry carries
      // its own `mmproj`, which the mmproj auto-fill below reads)
      const models = Array.isArray(allModels) ? allModels.filter(isLaunchableModel) : allModels;
      if (!alive) return;
      const buildList = (builds && builds.builds) || [];
      // allModels (mmproj files and draft heads included) answers "does this
      // profile's model file still exist"; models is what the picker offers.
      setCatalog((c) => ({ ...c, models: Array.isArray(models) ? models : [], allModels: Array.isArray(allModels) ? allModels : [], builds: buildList }));
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
  // A config without `devices` (older server/client) is converted through
  // the server's preview first.
  useEffect(() => {
    const lc = s.server.launchConfig;
    if (prefilledRef.current || !lc) return;
    prefilledRef.current = true;
    let alive = true;
    (async () => {
      const conv = needsDeviceConversion(lc) ? await convertLegacyConfig(client, lc) : null;
      if (!alive) return;
      const next = configToDraft(lc, draft, { skipEmpty: true, devices: conv ? conv.devices : undefined });
      setDraft((d) => configToDraft(lc, d, { skipEmpty: true, devices: conv ? conv.devices : undefined }));
      setRestoreNotes(uniqueWarnings(conv ? conv.warnings : [], unnamedDeviceNotes(next.devices)));
    })();
    return () => { alive = false; };
  }, [client, s.server.launchConfig]);

  // Cards (and workers) for the selected build, while the config editor is
  // up (the profile list needs none of it, and the server shells out for the
  // answer). Older servers list devices only: each becomes its own card.
  useEffect(() => {
    let alive = true;
    if (view !== 'editor') return undefined;
    const build = draft.build;
    if (!build) {
      setCatalog((c) => ({ ...c, devices: [], cards: [], cardsBuild: '', topology: null, devicesNote: '', devicesError: '' }));
      return undefined;
    }
    // 15s: the server shells out to the Vulkan/CUDA loader for
    // --list-devices, which itself allows an 8s hang (bad eGPU link) before
    // erroring -- a shorter client timeout would silently report no devices.
    // Never `?refresh=1` from here: this runs on every build change, and a
    // probe while a benchmark is on the cards has stalled it. The server
    // answers from its cache then (`cached`), and says so below the table.
    client.getJson(`/api/devices?build=${encodeURIComponent(draft.build)}`, { timeoutMs: 15000 })
      .then((d) => {
        if (!alive) return;
        const devices = (d && Array.isArray(d.devices)) ? d.devices : [];
        const found = d && Array.isArray(d.cards)
          ? d.cards
          : devices.map((x) => ({ name: x.description, vendor: 'other', backends: [x], preferredId: x.id, ambiguous: false }));
        const workers = d && Array.isArray(d.workers) ? d.workers : null;
        // This build's view of the machine: the server's own, else derived
        // from the card list (identical cards numbered in list order).
        const seen = normalizeTopology(d && d.topology) || topologyFromCatalog(found, workers || []);
        const devicesError = found.length === 0 && d && typeof d.error === 'string' ? d.error : '';
        setCatalog((c) => ({ ...c, devices, cards: found, cardsBuild: build, topology: seen, workers: workers || c.workers, devicesNote: found.length ? devicesListingNote(d) : '', devicesError }));
      })
      .catch((err) => { if (alive) setCatalog((c) => ({ ...c, devices: [], cards: [], cardsBuild: build, topology: null, devicesNote: '', devicesError: (err && err.message) || 'no answer' })); });
    return () => { alive = false; };
  }, [client, draft.build, view]);

  // Debounced live command preview for the editor's draft (server-side
  // resolution, same endpoint the web UI uses -- CLI and web can never
  // disagree), with the server's device warnings (e.g. a card that moved to
  // another id). Only while the editor is up: the profile list and the
  // confirm panel ask for their own preview when a launch is reviewed.
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (view !== 'editor') return undefined;
    if (!draft.modelPath || draft.ctx == null || draft.ngl == null) {
      setPreview({ command: '', error: null, warnings: [] });
      return undefined;
    }
    previewTimer.current = setTimeout(async () => {
      try {
        const res = await client.postJson('/api/preview-command', draftToConfig(draft));
        noteSplitField(res);
        setPreview({ command: (res && res.command) || '', error: (res && res.error) || null, warnings: (res && Array.isArray(res.warnings)) ? res.warnings : [] });
      } catch (err) {
        setPreview({ command: '', error: err.message, warnings: [] });
      }
    }, 400);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [client, draft, view]);

  // The Strata editor's live preview: the same endpoint, with the launch body a
  // saved profile would send (strataLaunchConfig). The dashboard merges the
  // overrides into its copy of the base file and answers with the
  // queue-serve.sh command of the base's own install -- or why it refuses
  // (a flag this install's engine lacks, a layer split that does not fit).
  useEffect(() => {
    if (view !== 'strata') return undefined;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!sDraft.strataBase) { setSPreview({ command: '', error: null, warnings: [] }); return undefined; }
    previewTimer.current = setTimeout(async () => {
      try {
        const res = await client.postJson('/api/preview-command', strataLaunchConfig(strataDraftToConfig(sDraft, sOrig)));
        setSPreview({ command: (res && res.command) || '', error: (res && res.error) || null, warnings: (res && Array.isArray(res.warnings)) ? res.warnings : [] });
      } catch (err) {
        setSPreview({ command: '', error: err.message, warnings: [] });
      }
    }, 400);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [client, sDraft, sOrig, view]);

  useEffect(() => () => { if (previewTimer.current) clearTimeout(previewTimer.current); }, []);

  // Exclusive-input gate: while an editor or an action is in flight, the
  // filter is being typed (q and digits are filter text) or a launch is under
  // review, the app-level handler (mode switch / quit) must stand down.
  modeGateRef.current = editor !== null || busy !== '' || filtering || view === 'confirm';
  if (viewRef) viewRef.current = view;

  // ---- the confirm view: one launch under review ----

  // Resolve a launch body with the dashboard (never spawns anything): the
  // command, the device plan, id warnings, and `busy` -- benchmark-queue items
  // running on a card this launch needs. A server without the busy-card guard
  // sends no `busy`; that reads as "free".
  async function fetchPreview(config) {
    try {
      const res = await client.postJson('/api/preview-command', config);
      noteSplitField(res);
      return {
        loading: false,
        command: (res && res.command) || '',
        error: (res && res.error) || null,
        warnings: res && Array.isArray(res.warnings) ? res.warnings : [],
        devices: res && Array.isArray(res.devices) ? res.devices : null,
        busy: normalizeBusy(res && res.busy),
        placement: res && typeof res.placement === 'string' && res.placement ? res.placement : null,
        splitMode: res && typeof res.splitMode === 'string' && res.splitMode ? res.splitMode : null,
        status: res && typeof res.status === 'string' ? res.status : null,
      };
    } catch (err) {
      return { ...EMPTY_PREVIEW, error: err.message };
    }
  }

  function openConfirm(p) {
    const id = ++pendingSeq.current;
    setStatus(null);
    setPending({ notes: [], problem: null, step: 'review', late: false, lateMessage: '', override: false, ...p, id });
    setView('confirm');
    return id;
  }
  const patchPending = (id, patch) => setPending((p) => (p && p.id === id ? { ...p, ...patch } : p));

  // Enter on a profile: launch it exactly as saved (profileLaunchPlan).
  async function openProfileConfirm(row) {
    const id = openConfirm({ kind: 'profile', origin: 'list', name: row.name, row, config: null, preview: { ...EMPTY_PREVIEW, loading: true } });
    const plan = await profileLaunchPlan(client, row.config);
    if (pendingSeq.current !== id) return;
    patchPending(id, { config: plan.config, notes: plan.notes, problem: plan.problem });
    const preview = plan.problem ? EMPTY_PREVIEW : await fetchPreview(plan.config);
    patchPending(id, { preview });
  }

  // b in the editor: the same review, for the draft as it stands.
  async function openDraftConfirm() {
    if (!draft.modelPath) { flash('Pick a model first (Enter on the Model field)', false); return; }
    const problem = splitProblem(draft.devices);
    if (problem) { flash(problem, false); return; }
    const config = draftToConfig(draft);
    const row = profileRow({ name: activeProfile || baseProfile || '', config, lastLoadedAt: 1 }, { models: catalog.allModels, topology: buildTopology });
    const id = openConfirm({ kind: 'draft', origin: 'editor', name: activeProfile, row, config, notes: restoreNotes, preview: { ...EMPTY_PREVIEW, loading: true } });
    const preview = await fetchPreview(config);
    // The draft has no saved availability: the preview's own `status` is its
    // fit on this machine. Only "can't run here" changes the panel (the
    // override gate); what was re-pointed or stood in is in the warnings.
    if (preview.status === 'unavailable') {
      const avail = { status: 'unavailable', reason: (preview.warnings || []).join('; '), placement: null };
      patchPending(id, { preview, row: { ...row, avail, runnable: false } });
    } else patchPending(id, { preview });
  }

  function closeConfirm() {
    const origin = pending && pending.origin;
    pendingSeq.current += 1; // drop a preview still in flight
    setPending(null);
    setStatus(null);
    setView(origin === 'editor' ? 'editor' : origin === 'strata' ? 'strata' : 'list');
  }

  // ---- the Strata editor ----

  // e on a Strata profile (or N for a new one): its base config and overrides
  // into the Strata form. The profile's other keys (tuningNote, needs, port)
  // are kept and saved back with it; its rawCommand is not.
  function openStrataEditor(row) {
    const cfg = row ? row.config : { engine: 'strata' };
    setSDraft(strataDraft(cfg));
    setSOrig(cfg || { engine: 'strata' });
    setSFocus(0);
    setSPreview({ command: '', error: null, warnings: [] });
    setActiveProfile(row ? row.name : null);
    setBaseProfile(row ? row.name : null);
    pendingSeq.current += 1;
    setPending(null);
    setView('strata');
    if (row) {
      flash(`Loaded Strata profile "${row.name}" into the Strata editor`);
      markProfileLoaded(client, row.name).catch(() => {});
    } else {
      flash('New Strata config — Enter on Base config picks the file (p saves it as a profile)');
    }
  }

  function setStrataField(key, value) {
    setSDraft((d) => ({ ...d, [key]: value }));
    setActiveProfile(null); // manual edit detaches from the saved profile
  }

  function commitStrataText(key, text) {
    const r = commitStrataField(key, text);
    if (r.error) { flash(r.error, false); return; }
    setStrataField(key, r.value);
    setEditor(null);
  }

  async function saveStrataAs(name) {
    const to = String(name || '').trim();
    setEditor(null);
    if (!to) return;
    if (!sDraft.strataBase) { flash('Pick a base config first (Enter on Base config)', false); return; }
    try {
      const cfg = strataDraftToConfig(sDraft, sOrig);
      await saveProfile(client, to, cfg);
      setSOrig(cfg);
      setActiveProfile(to);
      setBaseProfile(to);
      flash(`Saved Strata profile "${to}"`);
      refreshProfiles();
    } catch (err) {
      flash(err.message, false);
    }
  }

  // b in the Strata editor: the review every launch goes through.
  async function openStrataConfirm() {
    if (!sDraft.strataBase) { flash('Pick a base config first (Enter on Base config)', false); return; }
    const saved = strataDraftToConfig(sDraft, sOrig);
    const config = strataLaunchConfig(saved);
    const name = activeProfile || baseProfile || '';
    const row = profileRow({ name, config: saved, lastLoadedAt: 1 }, { strata: strataConfigs, strataScope, topology });
    const id = openConfirm({ kind: 'draft', origin: 'strata', name: activeProfile, row, config, preview: { ...EMPTY_PREVIEW, loading: true } });
    const preview = await fetchPreview(config);
    if (pendingSeq.current !== id) return;
    patchPending(id, { preview });
  }

  function strataKeys(input, key) {
    const n = STRATA_FIELDS.length;
    const fi2 = Math.min(sFocus, n - 1);
    if (key.escape || (input === 'l' && !key.ctrl)) { backToList(); return; }
    if (key.upArrow || (input === 'k' && !key.ctrl)) setSFocus((fi2 - 1 + n) % n);
    else if (key.downArrow || (input === 'j' && !key.ctrl)) setSFocus((fi2 + 1) % n);
    else if (key.return || key.rightArrow) {
      const [field, , kind] = STRATA_FIELDS[fi2];
      if (kind === 'base' || kind === 'choice') setEditor({ kind: 'strata-list', field });
      else setEditor({ kind: 'strata-text', field, value: sDraft[field] == null ? '' : String(sDraft[field]) });
    } else if (key.ctrl || key.meta) return;
    else if (input === 'd' || key.backspace || key.delete) {
      // back to the base file's value
      const [field, , kind] = STRATA_FIELDS[fi2];
      if (kind !== 'base') { setStrataField(field, null); flash(`${strataLabel(field)}: the base config's value`); }
    } else if (input === 'p') setEditor({ kind: 'name', value: activeProfile || baseProfile || '', onSubmit: saveStrataAs });
    else if (input === 'b') openStrataConfirm();
    else if (input === 'x') askStop();
    else if (input === 'R') askRestart();
  }

  function strataListOptions(field) {
    if (strataKind(field) === 'base') return baseItems(strataConfigs || [], strataInstalls, sDraft.strataBase);
    const entry = baseEntry(strataConfigs, sDraft.strataBase);
    const b = displayStrataValue({ [field]: null }, field, entry).text;
    return [{ label: `(${b})`, hint: 'keep the base config\'s value', value: null },
      ...strataChoices(field).map(([v, hint]) => ({ label: v, hint, value: v }))];
  }

  // A profile the server says this machine can't run: Enter does not launch
  // it; only the explicit override (O) takes it on to the second step.
  const blockedHere = (p) => !!(p && p.row && p.row.avail && p.row.avail.status === 'unavailable');

  // What this launch does beyond starting a server (see launchRisks) -- any
  // entry sends Enter to the second, explicit [y/N] step.
  function risksFor(p) {
    const cfg = p.config || p.row.config;
    const avail = p.row.avail || null;
    return launchRisks({
      running: run,
      busy: p.preview.busy,
      missingWhy: p.row.missing ? p.row.missingWhy : '',
      filePath: p.row.filePath,
      port: p.config && p.config.port,
      avail: blockedHere(p) && !p.override ? null : avail,
      split: planSplit(planCards(p.preview.devices, cfg, topology).length, p.preview, cfg),
    });
  }

  async function startWithRetry(body, { timeoutMs, retryRunning }) {
    const deadline = Date.now() + START_RETRY_MS;
    for (;;) {
      try {
        return await client.postJson('/api/start', body, { timeoutMs });
      } catch (err) {
        if (!retryRunning || !isRunningError(err) || Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, START_RETRY_GAP_MS));
      }
    }
  }

  // The one path to /api/start. A running server is stopped first (the
  // confirm step has said so). `force` and `allowUnavailable` are added to
  // the request only -- never to the draft or a profile (launchplan.js
  // startBody) -- and each only after its own question was answered yes:
  // `force` is the busy-card override and nothing else; `allowUnavailable`
  // goes with the O override of a profile this machine can't run (the config
  // itself is still sent exactly as saved). A 409 CARD_BUSY that arrives
  // anyway (the queue moved since the preview, or an older preview had no
  // `busy`) reopens the confirm view on its second step with the server's
  // list; a 409 UNAVAILABLE_HERE that arrives anyway (a draft or a restart
  // the preview called runnable) reopens it there too, with the server's
  // reason, as the same override question.
  async function runLaunch(p, { force = false, allowUnavailable = !!p.override, stopFirst = s.server.state !== 'stopped' } = {}) {
    // With a worker enabled, /api/start first auto-starts it over SSH and
    // waits (~25s) for its RPC port before spawning llama-server -- say so,
    // and give the request enough time that the CLI doesn't report a timeout
    // while the server carries on launching.
    const workers = pollableWorkers(p.config.devices);
    const what = workers.length
      ? `launching (starting RPC worker${workers.length > 1 ? 's' : ''} ${workers.join(', ')} if needed)`
      : 'launching';
    setBusy(stopFirst ? `stopping the running server, then ${what}` : what);
    setStatus(null);
    let stopped = false;
    try {
      if (stopFirst) {
        await client.postJson('/api/stop');
        stopped = true;
      }
      await startWithRetry(startBody(p.config, { force, allowUnavailable }),
        { timeoutMs: workers.length ? 90000 : 30000, retryRunning: stopped || p.kind === 'restart' });
      // Shared "last used" stamp (web's dropdown sorts on it too) --
      // best-effort, never blocks the launch.
      if (p.kind === 'profile' && p.name) markProfileLoaded(client, p.name).catch(() => {});
      flash('Launch requested — switching to Monitor');
      setTimeout(onLaunched, 250);
    } catch (err) {
      if (isCardBusyError(err)) {
        const busyNow = normalizeBusy(err.data.busy);
        openConfirm({
          ...p,
          preview: { ...p.preview, loading: false, busy: busyNow.length ? busyNow : p.preview.busy },
          step: 'risk', late: true, lateMessage: err.message,
        });
      } else if (isUnavailableHereError(err) && !allowUnavailable) {
        // The row takes the server's verdict, so the panel shows the reason
        // and the second step asks the override question; yes resends with
        // `allowUnavailable` (and with `force` only if a busy refusal came
        // first -- p.late is left as it was).
        const avail = availabilityFromError(err);
        openConfirm({
          ...p,
          row: { ...p.row, avail, runnable: false },
          preview: { ...p.preview, loading: false },
          step: 'risk', override: true, refused: true,
        });
      } else {
        const lead = stopped ? 'The running server was stopped, but the launch failed' : (workers.length ? 'Launch failed (RPC worker)' : 'Launch failed');
        flash(`${lead}: ${isRunningError(err) ? 'a server is still running — stop it first (x)' : tailLines(err.message, 8)}`, false);
      }
    } finally {
      setBusy('');
    }
  }

  // ---- stop / restart of the running server (every view; both ask first) ----

  function askStop() {
    if (!['ready', 'starting', 'loading'].includes(s.server.state)) { flash('No model running', false); return; }
    setEditor({
      kind: 'confirm',
      msg: `Stop the model server${run.model ? ` (${run.model}${run.uptime ? `, up ${run.uptime}` : ''})` : ''}?`,
      onYes: doStop,
    });
  }

  async function doStop() {
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

  // Restart = /api/stop, then /api/start with the SAME launch config the
  // server reported (there is no restart route). The config is resent as is,
  // a web launch's rawCommand included: nothing was edited, and that literal
  // command is what was running.
  function askRestart() {
    const cfg = s.server.launchConfig;
    if (s.server.state !== 'ready' || !cfg) { flash(s.server.state === 'stopped' ? 'No model running' : `Can't restart while the server is ${s.server.state}`, false); return; }
    const p = {
      kind: 'restart', origin: view === 'editor' ? 'editor' : 'list', name: null, config: cfg,
      row: profileRow({ name: '', config: cfg, lastLoadedAt: 1 }, { topology }),
      preview: { ...EMPTY_PREVIEW, command: s.server.launchCommand || '' },
    };
    setEditor({
      kind: 'confirm',
      msg: `Restart ${run.model || 'the model server'}${run.uptime ? ` (up ${run.uptime})` : ''}? It stops, then starts again with the same config.`,
      onYes: () => runLaunch(p, { stopFirst: true }),
    });
  }

  function fieldLabel(field) {
    const i = deviceIndex(field);
    if (i >= 0) {
      const e = rows[i] && rows[i].entry;
      return e ? `share of ${e.worker ? `RPC ${e.worker}` : deviceLabel(buildTopology, e)}` : 'share';
    }
    for (const [, fs] of GROUPS) {
      const f = fs.find((x) => x[0] === field);
      if (f) return f[1];
    }
    return field;
  }

  function commitText(field, value) {
    const v = value.trim();
    const di = deviceIndex(field);
    if (di >= 0) {
      const n = Number(v);
      if (v !== '' && (!Number.isFinite(n) || n < 0)) { flash('A share is a number >= 0 (blank = auto)', false); return; }
      editDevices((l) => setShareAt(l, di, v === '' ? null : n));
      setEditor(null);
      return;
    }
    const spec = NUM_SPECS[field];
    if (spec) {
      if (v === '') {
        setDraft((d) => ({ ...d, [field]: null })); // blank clears an optional number
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.int && !Number.isInteger(n))) {
          flash(`${fieldLabel(field)} must be a ${spec.int ? 'whole number' : 'number'} between ${spec.min} and ${spec.max}`, false);
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
    setDraft((d) => ({ ...d, [field]: !d[field] }));
    setActiveProfile(null);
  }

  function toggleRow(i) {
    const r = rows[i];
    if (!r) return;
    if (r.worker && r.worker.error && !r.entry.enabled) {
      flash(`RPC worker "${r.entry.worker}" has a config error: ${r.worker.error}`, false);
      return;
    }
    editDevices((l) => toggleDeviceAt(l, i));
  }

  // Enter on the Split mode row switches between the two modes offered, layer
  // and tensor. Anything else a saved config carries -- `row` (deprecated,
  // fails to load) above all -- goes back to layer. Where the mode is written
  // (launchconfig.js setSplitMode): the config's `splitMode` field once the
  // server has shown it knows the field, else the raw args.
  function toggleSplitMode() {
    const next = describeSplitMode(configSplitMode(draft)).mode === 'layer' ? 'tensor' : 'layer';
    const useField = splitFieldRef.current;
    setDraft((d) => ({ ...d, ...setSplitMode(d, next, { useField }) }));
    setActiveProfile(null);
    flash(next === 'tensor'
      ? `Split mode: tensor (experimental) — ${useField ? 'saved as the config\'s split mode' : '"-sm tensor" added to the raw args'}`
      : 'Split mode: layer (the default)');
  }

  function doSuggest() {
    const entries = rows.map((r) => r.entry);
    if (entries.filter((d) => d.enabled).length < 2) { flash('Suggest split needs two or more enabled devices', false); return; }
    const { devices, notes } = suggestShares(entries, {
      cards,
      gpus: (s.telemetry && Array.isArray(s.telemetry.gpus)) ? s.telemetry.gpus : [],
    });
    setDraft((d) => ({ ...d, devices }));
    setRestoreNotes([]);
    setActiveProfile(null);
    flash(notes.length ? `Split suggested from free VRAM · ${notes.join(' · ')}` : 'Split suggested from free VRAM');
  }

  async function saveAs(name) {
    const to = String(name || '').trim();
    setEditor(null);
    if (!to) return;
    try {
      await saveProfile(client, to, draftToConfig(draft));
      setActiveProfile(to);
      setBaseProfile(to);
      flash(`Saved profile "${to}"`);
      refreshProfiles();
    } catch (err) {
      flash(err.message, false);
    }
  }

  // Rename and duplicate act on the profile selected in the list and copy the
  // SAVED config as it is -- web-only keys (a Strata profile's engine and base
  // file, a tuning note) included, so a copy launches like its original. Only
  // rawCommand is left behind (saveProfile). Neither overwrites another
  // profile.
  async function copyProfile(row, name, { removeOriginal }) {
    const from = row.name;
    const to = String(name || '').trim();
    setEditor(null);
    if (!to || to === from) return;
    if (entries.some((e) => e.name === to)) { flash(`A profile named "${to}" already exists`, false); return; }
    try {
      // A rename keeps the "last used" stamp, so the profile keeps its place.
      await saveProfile(client, to, row.config, removeOriginal ? { lastLoadedAt: row.lastLoadedAt } : {});
      // Rename = save under the new name, THEN drop the old entry. If the
      // save lands but the delete fails, both exist and the error says so --
      // never delete first (that would lose the config).
      if (removeOriginal) await deleteProfile(client, from);
      if (removeOriginal && baseProfile === from) { setBaseProfile(to); setActiveProfile((a) => (a === from ? to : a)); }
      flash(removeOriginal ? `Renamed "${from}" → "${to}"` : `Duplicated "${from}" → "${to}"`);
    } catch (err) {
      // POST /api/profiles checks the model path on every save, so a profile
      // whose file is gone can't be re-saved under another name.
      flash(row.missing ? `${err.message} — the dashboard won't save a profile whose model file is gone (d still deletes it)` : err.message, false);
    }
    const st = await refreshProfiles();
    // The same order and filter the list will show for what was just loaded.
    const at = st
      ? filterRows(listable(profileListRows(st.entries, { availability: st.availability })), filter).findIndex((r) => r.name === to)
      : -1;
    if (at >= 0) setSel(at);
  }

  function askDelete(row) {
    setEditor({
      kind: 'confirm',
      msg: `Delete profile "${row.name}"?`,
      onYes: () => deleteProfile(client, row.name)
        .then(() => {
          if (baseProfile === row.name) { setBaseProfile(null); setActiveProfile(null); }
          flash(`Deleted "${row.name}"`);
        })
        .catch((err) => flash(err.message, false))
        .then(refreshProfiles),
    });
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

  // The worker `w` and `L` act on: the focused worker row, else the first
  // enabled worker, else the first configured one.
  function workerTarget() {
    if (focusedDevice >= 0 && rows[focusedDevice] && rows[focusedDevice].entry.worker) return rows[focusedDevice].entry.worker;
    const enabled = rows.find((r) => r.entry.worker && r.entry.enabled);
    if (enabled) return enabled.entry.worker;
    const any = rows.find((r) => r.entry.worker);
    return any ? any.entry.worker : '';
  }

  // RPC worker: start/stop a worker's ggml-rpc-server over SSH, exactly like
  // the web worker rows -- the server runs the ssh, the CLI just asks
  // (POST /api/worker/* {worker}). Launching doesn't need this (/api/start
  // auto-starts every enabled worker); it's for starting ahead of time or
  // freeing the laptop afterwards.
  async function toggleWorker() {
    const target = workerTarget();
    if (!target) { flash('No RPC workers configured (dashboard.config.json rpcWorkers)', false); return; }
    setBusy('worker');
    try {
      const st = await client.postJson('/api/worker/status', { worker: target });
      const state = st && st.status;
      if (state === 'running') {
        setEditor({ kind: 'confirm', msg: `Stop the RPC worker "${target}"?`, onYes: () => workerAction('stop', target) });
      } else if (state === 'stopped') {
        setEditor({ kind: 'confirm', msg: `Start the RPC worker "${target}"?`, onYes: () => workerAction('start', target) });
      } else {
        flash(`Worker "${target}" unreachable (${(st && st.error) || state || 'offline'})`, false);
      }
    } catch (err) {
      flash(`Worker status failed: ${err.message}`, false);
    } finally {
      setBusy('');
    }
  }

  async function workerAction(action, target) {
    setBusy(`worker ${action} ${target}`);
    workerBusyRef.current = true;
    setWorkerStatus((ws) => ({ ...ws, [target]: { status: action === 'start' ? 'starting' : 'stopping' } }));
    try {
      // start waits for the worker's RPC port on the server side -- allow it.
      const d = await client.postJson(`/api/worker/${action}`, { worker: target }, { timeoutMs: 60000 });
      if (d && d.success === false) {
        const e = new Error(d.error || `worker ${action} failed`);
        e.data = d;
        throw e;
      }
      flash(`RPC worker "${target}" ${action === 'start' ? 'started' : 'stopped'}`);
    } catch (err) {
      // The 500 body's error carries the worker's startup log tail; stderr
      // (when present) is the ssh side.
      const stderr = err.data && err.data.stderr ? `\n${tailLines(err.data.stderr, 4)}` : '';
      flash(`Worker ${action} failed: ${tailLines(err.message, 8)}${stderr}  (L: worker logs)`, false);
    } finally {
      workerBusyRef.current = false;
      setWorkerPollNonce((n) => n + 1); // re-poll the badges now
      setBusy('');
    }
  }

  // e on a profile: load it into the config editor. REPLACE, don't merge
  // with the current draft: a profile is a complete config. Merging would let
  // a minimal profile (e.g. v1-migrated, or `profile save -m X` with no
  // devices) silently inherit the draft's current devices and launch a
  // different topology than saved. Only the transport pick carries over;
  // rawCommand and unknown keys drop.
  async function editProfile(row) {
    if (row.strata) { openStrataEditor(row); return; }
    const prof = row.config;
    // A profile whose devices the server re-pointed at this machine (ids that
    // moved, a stand-in card) is loaded with that list, not the saved one --
    // and says so; saving it then stores what this machine runs.
    const resolved = row.avail && Array.isArray(row.avail.devices) ? row.avail.devices : null;
    const conv = !resolved && needsDeviceConversion(prof) ? await convertLegacyConfig(client, prof) : null;
    const devices = resolved || (conv ? conv.devices : undefined);
    const loaded = configToDraft(prof, DEFAULT_DRAFT, { devices });
    setDraft((d) => configToDraft(prof, { ...DEFAULT_DRAFT, transport: d.transport || DEFAULT_DRAFT.transport }, { devices }));
    setRestoreNotes(uniqueWarnings(resolved && row.availNote ? [`loaded for this machine: ${row.availNote}`] : [], conv ? conv.warnings : [], unnamedDeviceNotes(loaded.devices)));
    setActiveProfile(row.name);
    setBaseProfile(row.name);
    prefilledRef.current = true; // the profile, not the running config, owns the form now
    pendingSeq.current += 1;
    setPending(null);
    setGroupIdx(0);
    setFocusIdx(0);
    setView('editor');
    flash(`Loaded profile "${row.name}" into the editor`);
    // Shared "last used" stamp (web's dropdown sorts on it too) --
    // best-effort, never blocks the load.
    markProfileLoaded(client, row.name).catch(() => {});
  }

  function backToList() {
    setStatus(null);
    setView('list');
    refreshProfiles();
  }

  // Keys of the confirm view. Review step: Enter launches, unless something
  // is at stake (busy cards, a server to stop, a missing file, a stand-in
  // card) -- then it only opens the second step, where nothing but y goes
  // ahead. A profile this machine can't run is not launched by Enter at all:
  // O (override) is the one way on, and it too lands on the second step; the
  // yes there is what puts `allowUnavailable` on the request.
  function confirmKeys(input, key) {
    const p = pending;
    if (!p) { setView('list'); return; }
    if (p.step === 'risk') {
      if (input === 'y') {
        const force = p.late || p.preview.busy.length > 0;
        setPending({ ...p, step: 'review' });
        runLaunch(p, { force, allowUnavailable: !!p.override });
      } else if (key.escape || input === 'n' || input === 'q') {
        // A restart that the dashboard refused has already stopped the old
        // server: there is nothing to go back and review.
        if (p.kind === 'restart') closeConfirm();
        else setPending({ ...p, step: 'review', override: false });
      }
      return;
    }
    const blocked = blockedHere(p) && !p.override;
    // What stops any launch from this panel, with or without the override.
    const notReady = () => {
      if (p.problem) { flash(p.problem, false); return true; }
      if (p.preview.loading || !p.config) { flash('Still resolving the command with the dashboard…', false); return true; }
      if (p.preview.error) { flash(`Can't launch: ${p.preview.error}`, false); return true; }
      return false;
    };
    if (input === 'O' && !key.ctrl && blocked) {
      if (!notReady()) { setStatus(null); setPending({ ...p, override: true, step: 'risk' }); }
      return;
    }
    if (key.escape || input === 'q') { closeConfirm(); return; }
    if (input === 'e' && !key.ctrl && p.kind !== 'restart') {
      if (p.kind === 'draft') closeConfirm();
      else editProfile(p.row);
      return;
    }
    if (key.return || (input === 'b' && !key.ctrl)) {
      if (blocked) {
        flash(`This machine can't run this profile as saved${p.row.avail.reason ? ` (${p.row.avail.reason})` : ''} — e edits it for this machine, O overrides and launches it anyway`, false);
        return;
      }
      if (notReady()) return;
      if (risksFor(p).length > 0 || p.late) setPending({ ...p, step: 'risk' });
      else runLaunch(p);
    }
  }

  // Keys of the profile list. While the filter is being typed every
  // printable key is filter text; otherwise letters are commands.
  function listKeys(input, key) {
    const n = Math.max(shown.length, 1);
    const cur = shown[selIdx] || null;
    const move = (d) => setSel(((selIdx + d) % n + n) % n);
    if (filtering) {
      if (key.escape) { setFilter(''); setFiltering(false); setSel(0); }
      else if (key.return) { setFiltering(false); if (cur) openProfileConfirm(cur); }
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); setSel(0); }
      else if (input && !key.ctrl && !key.meta && !input.includes('[<')) {
        // A paste arrives as one multi-char event -- take it whole, control
        // characters stripped (the FuzzyList rule).
        const clean = input.replace(/[\u0000-\u001f\u007f]/g, '');
        if (clean) { setFilter((f) => (f + clean).slice(0, 60)); setSel(0); }
      }
      return;
    }
    if (key.upArrow || (input === 'k' && !key.ctrl)) move(-1);
    else if (key.downArrow || (input === 'j' && !key.ctrl)) move(1);
    else if (key.pageUp) setSel(Math.max(0, selIdx - listHeight));
    else if (key.pageDown) setSel(Math.min(n - 1, selIdx + listHeight));
    else if (key.return || key.rightArrow) { if (cur) openProfileConfirm(cur); }
    else if (input === '/') { setFiltering(true); setStatus(null); }
    else if (key.escape) { if (filter) { setFilter(''); setSel(0); } }
    else if (key.ctrl || key.meta) return;
    else if (input === 'e') { if (cur) editProfile(cur); }
    else if (input === 'n') { setStatus(null); setView('editor'); }
    else if (input === 'N') openStrataEditor(null);
    else if (input === 'd') { if (cur) askDelete(cur); }
    else if (input === 'r') {
      if (cur) setEditor({ kind: 'name', value: cur.name, label: `Rename profile "${cur.name}" to`, onSubmit: (v) => copyProfile(cur, v, { removeOriginal: true }) });
    } else if (input === 'c') {
      if (cur) setEditor({ kind: 'name', value: `${cur.name} (copy)`, label: `Duplicate profile "${cur.name}" as`, onSubmit: (v) => copyProfile(cur, v, { removeOriginal: false }) });
    } else if (input === 'u') {
      if (counts.unavailable === 0) { flash('Every saved profile can run on this machine — nothing to hide'); return; }
      setHideUnavailable((v) => !v);
      setSel(0);
      setStatus(null);
    } else if (input === 'x') askStop();
    else if (input === 'R') askRestart();
  }

  useInput((input, key) => {
    // Hidden behind the help overlay (app.js): the keys are the overlay's.
    if (busy || !visible) return;
    if (editor) {
      if (editor.kind === 'confirm') {
        if (key.escape || input === 'n' || input === 'q') setEditor(null);
        else if (input === 'y') { const cb = editor.onYes; setEditor(null); if (cb) cb(); }
        return;
      }
      if (key.escape) setEditor(null);
      return; // list/text editors handle their own keys
    }
    if (view === 'confirm') { confirmKeys(input, key); return; }
    if (view === 'strata') { strataKeys(input, key); return; }
    if (view !== 'editor') { listKeys(input, key); return; }
    // ---- the config editor ----
    if (key.escape || (input === 'l' && !key.ctrl)) { backToList(); return; }
    const n = fields.length;
    const di = focusedDevice;
    // ink 5 renamed the arrow flags from key.up/down/left/right to
    // key.upArrow/downArrow/leftArrow/rightArrow (ink <=4 used the old names).
    if (key.tab) setGroupIdx((g) => (g + 1) % GROUPS.length), setFocusIdx(0);
    else if (key.leftArrow) setGroupIdx((g) => (g - 1 + GROUPS.length) % GROUPS.length), setFocusIdx(0);
    else if (key.upArrow || (input === 'k' && !key.ctrl)) setFocusIdx((i) => (Math.min(i, n - 1) - 1 + n) % n);
    else if (key.downArrow || (input === 'j' && !key.ctrl)) setFocusIdx((i) => (Math.min(i, n - 1) + 1) % n);
    else if (key.return || key.rightArrow || (input === ' ' && di >= 0)) {
      const [field, , kind] = fields[fi];
      if (kind === 'device') toggleRow(di);
      else if (kind === 'action') doSuggest();
      else if (kind === 'split') toggleSplitMode();
      else if (kind === 'info') flash(draft.build ? 'No devices detected for this build (yet)' : 'Pick a build first (core group)', false);
      else if (kind === 'toggle') toggleField(field);
      else if (kind === 'list') setEditor({ kind: 'list', field });
      else setEditor({ kind: 'text', field, value: draft[field] == null ? '' : String(draft[field]) });
    } else if (di >= 0 && input === '+') {
      editDevices((l) => adjustShareAt(l, di, SHARE_STEP));
    } else if (di >= 0 && input === '-') {
      editDevices((l) => adjustShareAt(l, di, -SHARE_STEP));
    } else if (di >= 0 && input === 'e' && !key.ctrl) {
      const share = rows[di] && rows[di].entry.share;
      setEditor({ kind: 'text', field: `dev:${di}`, value: share == null ? '' : String(share) });
    } else if (di >= 0 && input === '[') {
      if (di > 0) { editDevices((l) => moveDeviceAt(l, di, -1)); setFocusIdx(fi - 1); }
    } else if (di >= 0 && input === ']') {
      if (di < rows.length - 1) { editDevices((l) => moveDeviceAt(l, di, 1)); setFocusIdx(fi + 1); }
    } else if (di >= 0 && input === 'v' && !key.ctrl) {
      const card = rows[di] && rows[di].card;
      if (!card || (card.backends || []).length < 2) flash('This device is reachable through one backend only', false);
      else {
        editDevices((l) => cycleBackendAt(l, di, card));
        // Which id of one backend is which id of another, between identical
        // cards, is not something llama.cpp reports: the server pairs them by
        // order (`orderAssumed`). Say so at the one moment it matters.
        const tc = cardOfId(buildTopology, rows[di].entry.id);
        if (tc && tc.orderAssumed) flash(`${tc.label}: its ids across backends (${tc.ids.join(' / ')}) are paired with the card by order — llama.cpp does not say which is which`);
      }
    } else if (input === 'S' && !key.ctrl) {
      doSuggest();
    } else if (input === 'p' && !key.ctrl) {
      setEditor({ kind: 'name', value: activeProfile || baseProfile || '' });
    } else if (input === 'L' && !key.ctrl) {
      const target = workerTarget();
      if (!target) flash('No RPC workers configured (dashboard.config.json rpcWorkers)', false);
      else setEditor({ kind: 'logs', worker: target, text: '', error: null });
    } else if (input === '/' && !key.ctrl) openFlags();
    else if (input === 'w' && !key.ctrl) toggleWorker();
    else if (input === 'b' && !key.ctrl) openDraftConfirm();
    else if (input === 'x' && !key.ctrl) askStop();
    else if (input === 'R' && !key.ctrl) askRestart();
  });

  // ---- list picker options per list field ----
  function listOptions(field) {
    switch (field) {
      case 'modelPath': {
        const items = catalog.models.map((mm) => ({ label: modelName(mm.name), hint: `${mm.size} GB · ${mm.source}`, value: mm.path }));
        if (draft.modelPath && !items.some((ii) => ii.value === draft.modelPath)) {
          items.unshift({ label: modelName(draft.modelPath), hint: '(current)', value: draft.modelPath });
        }
        return items;
      }
      case 'build':
        return catalog.builds.map((bb) => ({ label: bb.label, hint: bb.id, value: bb.id }));
      case 'specDraftDevice': {
        // Enabled LOCAL devices only: drafting on an RPC worker would add a
        // network round trip to every draft step (the server rejects it).
        const locals = rows.filter((r) => r.entry.enabled && !r.entry.worker);
        return [{ label: 'default', hint: 'llama-server decides', value: '' },
          ...locals.map((r) => ({ label: r.entry.id, hint: r.entry.name ? deviceLabel(buildTopology, r.entry) : '', value: r.entry.id }))];
      }
      case 'cacheK':
      case 'cacheV': {
        const items = [{ label: '(none — f16 default)', hint: '', value: '' },
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
        const items = [{ label: '(none — auto)', hint: '', value: '' },
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

  // ---- one device row: [x] name  backend  share (%)  vram / worker badge ----
  function deviceView(i) {
    const r = rows[i];
    const e = r.entry;
    const pct = percents[i];
    const check = h(Text, { color: e.enabled ? 'green' : 'gray' }, e.enabled ? '[x] ' : '[ ] ');
    const shareTxt = e.enabled
      ? `share ${e.share == null ? 'auto' : e.share}${pct == null || pct === 'auto' ? '' : ` (${pct}%)`}  `
      : '';
    if (e.worker) {
      const w = r.worker;
      const st = workerStatus[e.worker];
      const badge = e.enabled ? (WORKER_BADGES[st && st.status] || WORKER_BADGES.checking) : null;
      const err = st && st.error && (st.status === 'offline' || st.status === 'error')
        ? ` ${String(st.error).split('\n')[0].slice(0, Math.max(10, cols - 70))}` : '';
      return h(Box, null,
        check,
        h(Text, { bold: e.enabled, dimColor: !e.enabled }, pad(`RPC ${e.worker}`, 17)),
        r.missing ? h(Text, { color: 'red' }, '(not configured)  ') : null,
        w && w.error ? h(Text, { color: 'red' }, `config error: ${String(w.error).slice(0, 40)}  `) : null,
        w && !w.error && cols >= 110 ? h(Text, { dimColor: true }, `${w.ssh || w.name}${w.devices ? ` · ${w.devices}` : ''}  `) : null,
        shareTxt ? h(Text, { color: splitBad ? 'red' : undefined }, shareTxt) : null,
        badge ? h(Text, { color: badge[1], bold: st && st.status === 'running' }, `[${badge[0]}]`) : null,
        err ? h(Text, { dimColor: true }, err) : null,
      );
    }
    // The row is one physical card: its topology label (identical cards are
    // "#1", "#2"), the id in use and, in brackets, every id that reaches it.
    const card = r.card;
    const backends = card ? (card.backends || []).map((x) => x.id) : [];
    const b = card ? findBackend([card], e.id) : null;
    return h(Box, null,
      check,
      h(Text, { bold: e.enabled, dimColor: !e.enabled }, pad(deviceLabel(buildTopology, e), 17)),
      h(Text, { color: e.enabled ? 'cyan' : undefined, dimColor: !e.enabled },
        `${e.id}${backends.length > 1 ? ` (v: ${backends.join('/')})` : ''}  `),
      r.missing ? h(Text, { color: 'red' }, '(not a device in this build)  ') : null,
      shareTxt ? h(Text, { color: splitBad ? 'red' : undefined }, shareTxt) : null,
      b && cols >= 120 ? h(Text, { dimColor: true }, `${gb(b.freeMib)}/${gb(b.totalMib)} GB free`) : null,
    );
  }

  // ---- field value display ----
  function displayValue(field) {
    const di = deviceIndex(field);
    if (di >= 0) return deviceView(di);
    const kind = kindOf(field);
    const v = draft[field];
    switch (field) {
      case 'devices':
        // Asked and answered with nothing: say so (and why) instead of "detecting" for ever.
        if (draft.build && catalog.cardsBuild === draft.build) {
          return h(Text, { color: catalog.devicesError ? 'yellow' : undefined, dimColor: !catalog.devicesError, wrap: 'truncate-end' },
            catalog.devicesError ? `no device list from the dashboard (${catalog.devicesError})` : 'no devices in this build');
        }
        return h(Text, { dimColor: true }, draft.build ? 'detecting devices… (none yet)' : '(pick a build first)');
      case 'splitMode': {
        const sm = describeSplitMode(configSplitMode(draft));
        return h(Box, null,
          h(Text, { color: sm.level === 'bad' ? 'red' : sm.level === 'warn' ? 'yellow' : undefined, bold: sm.level === 'bad' }, sm.text),
          cols >= 110 ? h(Text, { dimColor: true }, `   Enter: ${sm.mode === 'layer' ? 'tensor (experimental)' : 'back to layer'}`) : null);
      }
      case 'suggest': {
        const auto = percents.some((p) => p === 'auto');
        return h(Text, { dimColor: true }, auto
          ? 'Enter / S: shares from free VRAM (split is auto until every enabled row has one)'
          : 'Enter / S: recompute shares from free VRAM');
      }
      case 'modelPath': {
        if (!v) return h(Text, { color: 'yellow' }, '(none — press Enter to pick)');
        const known = catalog.models.find((mm) => mm.path === v);
        if (known) {
          return h(Box, null,
            h(Text, null, modelName(known.name)),
            h(Text, { dimColor: true }, `  ${known.size} GB · ${known.source}`));
        }
        // Not in the scan (pasted path): show basename + a truncated path so
        // a 110-char HF snapshot path doesn't wrap the row on an 80-col term.
        const maxPath = Math.max(20, cols - 35);
        const shown = v.length > maxPath ? '…' + v.slice(v.length - maxPath + 1) : v;
        return h(Box, null, h(Text, null, modelName(v)), h(Text, { dimColor: true }, `  ${shown}`));
      }
      case 'build': {
        const b = catalog.builds.find((bb) => bb.id === v);
        return b
          ? h(Box, null, h(Text, null, b.label), h(Text, { dimColor: true }, `  [${b.id}]`))
          : h(Text, { color: v ? undefined : 'yellow' }, v || '(none — press Enter to pick)');
      }
      case 'specDraftDevice': {
        if (!v) return h(Text, { color: 'gray' }, 'default');
        const enabledLocal = rows.some((r) => r.entry.enabled && !r.entry.worker && r.entry.id === v);
        return enabledLocal
          ? h(Text, null, v)
          : h(Box, null, h(Text, null, v), h(Text, { color: 'yellow' }, '  (not an enabled local device — sent as default)'));
      }
      case 'mmprojOffload': {
        // The stored flag is llama.cpp's own GPU-offload flag (true = VRAM)
        // -- the field is labeled "Offload to system RAM" instead, so what's
        // shown here is the inverse: on/green means system RAM (the default),
        // off/gray means VRAM.
        const ram = v === false;
        return h(Text, { color: ram ? 'green' : 'gray' }, ram ? 'on' : 'off');
      }
      case 'transport':
        return h(Text, null, v || DEFAULT_DRAFT.transport);
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

  const offlineWarn = s.conn !== 'live';

  // Mouse click hit-testing: the profile rows in the list view; the
  // group-tab row and the field rows below it in the editor. This row math
  // MUST mirror the JSX at the bottom of this component exactly (the two
  // Launch header rows, the conditional offline-warning row, then per view:
  // the list's three header rows and its rows -- or the group-tab row, then
  // one row per field) -- any row added/removed above them there needs the
  // same edit here.
  // Suspend the terminal's mouse tracking while a keyboard editor is open
  // (or the list filter is being typed): the text fields need the terminal's
  // OWN middle-click paste (primary selection), and with tracking on the
  // terminal would report that middle-click as an SGR sequence that
  // ink-text-input inserts verbatim (see mouse.js's gate comment). Confirm
  // prompts are excluded -- they take only y/n/Esc, no text, so nothing there
  // can be corrupted.
  const mouseGated = (editor !== null && editor.kind !== 'confirm') || filtering;
  useEffect(() => {
    setMouseGate(mouseGated);
    return () => setMouseGate(false);
  }, [mouseGated]);

  const headerRows = APP_HEADER_ROWS + 2 /* running line + stop/restart line */ + (offlineWarn ? 1 : 0);
  const groupTabsRow = headerRows + 1;
  const fieldsStartRow = groupTabsRow + 1;
  const listFirstRow = headerRows + 3 /* Profiles, filter, column heads */ + (profileRows.length === 0 ? 1 : 0) + 1;
  useMouseClicks(true, ({ x, y }) => {
    // A list/text/name/flags editor owns the keyboard already (see the
    // useInput guard above) -- a confirm prompt is the one editor kind still
    // safe to click past, since y/n/Esc are its only inputs and none of them
    // live in the field list or group tabs.
    if (busy || !visible || (editor && editor.kind !== 'confirm')) return;
    if (view === 'list') {
      // A click selects the profile under it; launching stays on the keyboard.
      const i = y - listFirstRow;
      const idx = listTop(selIdx, shown.length, listHeight) + i;
      if (i >= 0 && i < listHeight && idx < shown.length) setSel(idx);
      return;
    }
    if (view !== 'editor') return;
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
      // List/text/num fields and device rows only move focus; flipping a
      // device on a stray click would silently change the launch topology.
      if (kind === 'toggle') toggleField(field);
    }
  });

  // Keep the stored focus inside the (possibly shrunk) field list.
  useEffect(() => { if (focusIdx !== fi) setFocusIdx(fi); }, [focusIdx, fi]);

  const groupTabs = GROUPS.map(([g], i) =>
    h(Text, { key: g, bold: i === groupIdx, color: i === groupIdx ? 'cyan' : undefined, dimColor: i !== groupIdx },
      ` ${i === groupIdx ? '▏' : '□'}${g}`));

  const formRows = fields.map(([field, label], i) => {
    const focused = i === fi && !editor;
    return h(Box, { key: field },
      h(Text, null,
        focused ? h(Text, { bold: true, color: 'green' }, '› ') : '  ',
        h(Text, { bold: focused, dimColor: !focused }, pad(label, 15)),
      ),
      displayValue(field),
    );
  });

  let editorView = null;
  if (editor && editor.kind === 'strata-list') {
    editorView = h(FuzzyList, {
      title: `Select ${strataLabel(editor.field)}`,
      items: strataListOptions(editor.field),
      onSelect: (it) => { setStrataField(editor.field, it.value); setEditor(null); },
      onCancel: () => setEditor(null),
    });
  } else if (editor && editor.kind === 'strata-text') {
    const kind = strataKind(editor.field);
    const hint = editor.field === 'gpu' ? ' (0, or 0,1 for both cards; blank = base)'
      : editor.field === 'layerSplit' ? ' (auto, or the first layer of each later card: 27; blank = base)'
        : kind === 'num' || kind === 'float' ? ' (blank = base)' : '';
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, `${strataLabel(editor.field)}${hint} (Enter to commit, Esc to cancel):`),
      h(TextInput, {
        value: editor.value,
        onChange: (v) => setEditor((e) => ({ ...e, value: v })),
        onSubmit: (v) => commitStrataText(editor.field, v),
      }),
    );
  } else if (editor && editor.kind === 'list') {
    editorView = h(FuzzyList, {
      title: `Select ${fieldLabel(editor.field)}`,
      items: listOptions(editor.field),
      onSelect: (it) => {
        setDraft((d) => {
          const next = { ...d, [editor.field]: it.value };
          if (editor.field === 'modelPath') {
            // The mmproj path follows the model (server-discovered, see
            // lib/mmproj.js) unless the user typed a different one.
            const discovered = (p) => ((catalog.models.find((mm) => mm.path === p) || {}).mmproj || '');
            if (!d.mmprojPath || d.mmprojPath === discovered(d.modelPath)) next.mmprojPath = discovered(it.value);
          }
          return next;
        });
        setEditor(null);
        setActiveProfile(null);
      },
      onCancel: () => setEditor(null),
    });
  } else if (editor && editor.kind === 'text') {
    const isShare = deviceIndex(editor.field) >= 0;
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, `${isShare ? `Share (${fieldLabel(editor.field)}; blank = auto)` : fieldLabel(editor.field)} (Enter to commit, Esc to cancel):`),
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
      title: `Flags · ${draft.build}  (${editor.flags.length})`,
      items: editor.flags.map((f) => ({
        label: f.flags,
        hint: (f.description || '').length > 64 ? `${f.description.slice(0, 63)}…` : (f.description || ''),
        value: f,
      })),
      onSelect: (it) => insertFlag(it.value),
      onCancel: () => setEditor(null),
    });
  } else if (editor && editor.kind === 'logs') {
    // Fixed-height tail so the 3s refresh never changes the screen height.
    const LOG_ROWS = 15;
    const maxW = Math.max(20, cols - 4);
    const lines = (editor.error || editor.text || 'fetching…').replace(/\s+$/, '').split('\n').slice(-LOG_ROWS);
    while (lines.length < LOG_ROWS) lines.unshift(' ');
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { bold: true }, `Worker logs · ${editor.worker}  `, h(Text, { dimColor: true }, '(refreshes every 3s · Esc closes)')),
      ...lines.map((ln, i) => h(Text, { key: i, dimColor: !editor.error, color: editor.error ? 'red' : undefined },
        ` ${ln.length > maxW ? ln.slice(0, maxW - 1) + '…' : ln}`)),
    );
  } else if (editor && editor.kind === 'confirm') {
    editorView = h(Box, null,
      h(Text, { color: 'yellow' }, ` ${editor.msg} `),
      h(Text, { bold: true }, '[y/N]'),
    );
  }

  const warnings = uniqueWarnings(restoreNotes, preview.warnings || []);
  const onDeviceRow = groupIdx === HW_GROUP && focusedDevice >= 0;
  // The device table's own footnote (hw group only): the listing came from
  // the dashboard's cache. Dim -- it is how the table normally arrives while
  // a benchmark is running, not a problem with it.
  const devicesNote = groupIdx === HW_GROUP && catalog.cardsBuild === draft.build ? catalog.devicesNote : '';

  // One status line: the last message, else what is in flight.
  const statusLine = status
    ? h(Text, { color: status.ok ? 'green' : 'red', wrap: view === 'editor' ? 'wrap' : 'truncate-end' }, ` ${status.text}`)
    : busy
      ? h(Text, { color: 'yellow', wrap: 'truncate-end' }, ` ${busy}…`)
      : null;

  const header = [
    h(RunningLine, { key: 'run', run, cols }),
    h(RunningActions, { key: 'acts', run }),
    offlineWarn
      ? h(Text, { key: 'offline', color: 'red', wrap: 'truncate-end' }, 'dashboard offline — profiles, catalog and preview unavailable (reconnecting…)')
      : null,
  ];
  const serverKeys = run.active && run.state !== 'stopping'
    ? [['x', 'stop server'], ...(run.state === 'ready' ? [['R', 'restart']] : [])]
    : [];

  if (!visible) return null;

  if (view === 'loading') {
    return h(Box, { flexDirection: 'column' },
      ...header,
      h(Text, { dimColor: true }, ' loading profiles…'),
    );
  }

  if (view === 'list') {
    // The prompt area is always two lines (a name prompt needs both), so a
    // message or a confirm never moves the key hints under it.
    const prompt = editor && editor.kind === 'name'
      ? editorView
      : h(Box, { flexDirection: 'column' }, (editor && editorView) || statusLine || h(Text, null, ' '), h(Text, null, ' '));
    return h(Box, { flexDirection: 'column' },
      ...header,
      h(ProfileList, {
        rows: shown, allRows: profileRows, sel: selIdx, height: listHeight, cols, filter, filtering, loadError,
        counts, signature: topology ? topology.signature : '', hideUnavailable,
      }),
      prompt,
      h(KeymapBar, {
        hints: filtering
          ? [['type', 'filter'], ['↑/↓', 'select'], ['Enter', 'review the selected profile'], ['Esc', 'clear the filter']]
          : [['Enter', 'review & launch'], ['e', 'edit'], ['n', 'new config'], ['/', 'filter'], ['↑/↓', 'select']],
      }),
      h(KeymapBar, {
        hints: filtering
          ? []
          : [['d', 'delete'], ['r', 'rename'], ['c', 'duplicate'], ...serverKeys, ['?', 'help'], ['q', 'quit']],
      }),
    );
  }

  if (view === 'confirm' && pending) {
    const risks = risksFor(pending);
    const ready = !pending.preview.loading && !pending.preview.error && !pending.problem && !!pending.config;
    const blocked = blockedHere(pending) && !pending.override;
    return h(Box, { flexDirection: 'column' },
      ...header,
      h(LaunchConfirm, {
        pending, risks, builds: catalog.builds, cols,
        topology: pending.kind === 'draft' ? buildTopology : topology,
        maxRows: termRows - CONFIRM_CHROME_ROWS - (offlineWarn ? 1 : 0),
      }),
      statusLine || h(Text, null, ' '),
      h(KeymapBar, {
        hints: pending.step === 'risk'
          ? [['y', 'yes, go ahead'], ['n / Esc', 'cancel']]
          : [
            ...(ready && !blocked ? [['Enter', risks.length > 0 || pending.late ? 'launch (asks once more)' : 'launch']] : []),
            // Short on purpose: this row must not wrap at 80 columns (the box above says what the override does).
            ...(ready && blocked ? [['O', 'override (asks once more)']] : []),
            ...(pending.kind === 'restart' ? [] : [['e', pending.kind === 'draft' ? 'back to the editor' : (blocked ? 'edit for this machine' : 'edit before launching')]]),
            ['Esc', pending.origin === 'editor' ? 'back' : 'back to profiles'],
          ],
      }),
    );
  }

  if (view === 'strata') {
    const entry = baseEntry(strataConfigs, sDraft.strataBase);
    const fi2 = Math.min(sFocus, STRATA_FIELDS.length - 1);
    const draftOf = activeProfile
      ? `profile: ${activeProfile}`
      : baseProfile ? `profile: ${baseProfile} (edited — p saves)` : '(new Strata config — p saves it as a profile)';
    const rowsS = STRATA_FIELDS.map(([field, label], i) => {
      const focused = i === fi2 && !editor;
      const v = displayStrataValue(sDraft, field, entry);
      return h(Box, { key: field },
        h(Text, null,
          focused ? h(Text, { bold: true, color: 'green' }, '› ') : '  ',
          h(Text, { bold: focused, dimColor: !focused }, pad(label, 15)),
        ),
        h(Text, { color: v.missing ? 'yellow' : undefined, dimColor: !v.set, wrap: 'truncate-end' }, v.text),
      );
    });
    const inst = installLine(entry, strataInstalls);
    const notListed = sDraft.strataBase && Array.isArray(strataConfigs) && !entry;
    return h(Box, { flexDirection: 'column' },
      ...header,
      h(Box, null, h(Text, { bold: true, color: 'cyan' }, ' Strata engine'), h(Text, { dimColor: true, wrap: 'truncate-end' }, `   ${draftOf}`)),
      h(Box, { flexDirection: 'column' }, ...rowsS),
      h(Text, { color: notListed ? 'yellow' : undefined, dimColor: !notListed, wrap: 'truncate-end' },
        notListed ? ' ⚠ this base config is not in the dashboard\'s Strata list (strataInstalls)' : (inst ? ` ${inst}` : ' ')),
      editorView,
      !editor
        ? h(Box, { flexDirection: 'column' },
          sPreview.warnings.length > 0 ? h(Text, { color: 'yellow', wrap: 'wrap' }, `⚠ ${sPreview.warnings.join(' · ')}`) : null,
          h(Text, { dimColor: true }, 'command:'),
          sPreview.error
            ? h(Text, { color: 'red', wrap: 'wrap' }, `  ${sPreview.error}`)
            : sPreview.command
              ? h(Text, { wrap: 'wrap' }, `  ${sPreview.command}`)
              : h(Text, { dimColor: true }, '  (pick a base config to preview)'),
        )
        : null,
      statusLine,
      h(KeymapBar, {
        hints: cols >= 120
          ? [['↑/↓', 'field'], ['Enter', 'edit'], ['d', 'back to base'], ['p', 'save profile'], ['b', 'review & launch'], ...serverKeys, ['Esc', 'profiles']]
          : [['Enter', 'edit'], ['d', 'base'], ['p', 'save'], ['b', 'launch'], ['Esc', 'profiles']],
      }),
    );
  }

  // ---- the config editor ----
  const tabsLen = GROUPS.reduce((n, [g]) => n + 2 + g.length, 0);
  const draftOf = activeProfile
    ? `profile: ${activeProfile}`
    : baseProfile
      ? `profile: ${baseProfile} (edited — p saves)`
      : s.server.launchConfig ? '(from the running config)' : '(new config — p saves it as a profile)';
  const draftLabel = draftOf.length > cols - tabsLen - 4 ? `${draftOf.slice(0, Math.max(1, cols - tabsLen - 5))}…` : draftOf;

  return h(Box, { flexDirection: 'column' },
    ...header,

    h(Box, null, ...groupTabs, cols - tabsLen > 12 ? h(Text, { dimColor: true }, `   ${draftLabel}`) : null),
    h(Box, { flexDirection: 'column' }, ...formRows),
    h(Text, null, ' '),

    editorView,
    h(Text, null, ' '),

    !editor
      ? h(Box, { flexDirection: 'column' },
        devicesNote ? h(Text, { dimColor: true, wrap: 'truncate-end' }, `· ${devicesNote}`) : null,
        warnings.length > 0
          ? h(Text, { color: 'yellow', wrap: 'wrap' }, `⚠ ${warnings.join(' · ')}`)
          : null,
        h(Text, { dimColor: true }, 'command:'),
        preview.error
          ? h(Text, { color: 'red' }, `  ${preview.error}`)
          : preview.command
            ? h(Text, { wrap: 'wrap' }, `  ${preview.command}`)
            : h(Text, { dimColor: true }, '  (set model, ctx and ngl to preview)'),
      )
      : null,

    statusLine,

    // Responsive: a wrapping keymap bar is exactly the layout thrash the
    // monitor view was fixed for, so there's a wide set, a narrow set, and a
    // device-row set while a device is focused. The '?' overlay has the
    // complete map either way.
    h(KeymapBar, {
      hints: onDeviceRow
        ? (cols >= 132
          ? [
            ['space', 'toggle'], ['+/-', 'share'], ['e', 'set share'], ['[/]', 'order'], ['v', 'backend'],
            ['S', 'suggest'], ['w', 'worker'], ['L', 'wlogs'], ['b', 'review & launch'], ['Esc', 'profiles'],
          ]
          : [['space', 'toggle'], ['+/-', 'share'], ['[/]', 'order'], ['v', 'backend'], ['S', 'suggest'], ['b', 'launch']])
        : cols >= 132
          ? [
            ['↑/↓', 'field'], ['tab/←', 'group'], ['Enter', 'edit'], ['p', 'save profile'],
            ['/', 'flags'], ['w', 'worker'], ['L', 'wlogs'], ['b', 'review & launch'], ...serverKeys, ['Esc', 'profiles'],
          ]
          : [
            ['Enter', 'edit'], ['tab', 'group'], ['p', 'save'], ['/', 'flags'],
            ['b', 'launch'], ...(serverKeys.length ? [['x', 'stop']] : []), ['Esc', 'profiles'],
          ],
    }),
  );
}
