import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { h } from '../h.js';
import { FuzzyList } from '../components/fuzzylist.js';
import { KeymapBar } from '../components/statusbar.js';
import { useAppStore } from '../state.js';
import { listProfiles, saveProfile, deleteProfile, markProfileLoaded } from '../profiles.js';
import { pad } from '../format.js';

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
  ['hw', [
    ['deviceA', 'GPU A', 'list'],
    ['deviceB', 'GPU B', 'list'],
    ['tensorSplit', 'Tensor split', 'num'],
    ['rpcTarget', 'RPC target', 'text'],
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
    ['loadMode', 'Load mode', 'list'],
    ['verbosity', 'Verbosity', 'num'],
  ]],
  ['raw', [
    ['argString', 'Raw args', 'text'],
  ]],
];

// Every field key, in group order -- the draft shape. null = unset (the
// server's toFiniteNumber/toNonEmptyString skip both null and ''), false for
// toggles. These keys match the dashboard launchConfig keys 1:1, so a
// prefilled draft round-trips into /api/start losslessly.
const DEFAULT_DRAFT = {
  modelPath: '', build: '', ctx: 8192, ngl: 99, port: 8080,
  deviceA: null, deviceB: null, tensorSplit: 50, rpcTarget: '',
  fa: false, cacheK: '', cacheV: '',
  specType: '', specDraftNMax: null, specDraftNMin: null, specDraftModel: '',
  specDraftNgl: null, specNgramSizeN: null, specNgramSizeM: null, specNgramMinHits: null,
  nCpuMoe: null,
  temp: null, topK: null, topP: null, minP: null, presencePenalty: null, repeatPenalty: null,
  jinja: false, reasoningPreserve: false, chatTemplateFile: '',
  mmprojEnabled: false, mmprojPath: '', loadMode: '', verbosity: null,
  argString: '',
};
// Legacy web-profile field that buildLlamaArgs still honors -- carried
// through on prefill/save even though the TUI has no field for it.
const DRAFT_KEYS = [...Object.keys(DEFAULT_DRAFT), 'preserveThinking'];

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
  verbosity: { min: 0, max: 10, int: true },
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
function labelOf(field) {
  for (const [, fields] of GROUPS) {
    const f = fields.find((x) => x[0] === field);
    if (f) return f[1];
  }
  return field;
}

export function Launch({ appStore, client, serverUrl, modeGateRef, onLaunched }) {
  const { stdout } = useStdout();
  const cols = (stdout && stdout.columns) || 80;
  const s = useAppStore(appStore);
  const [draft, setDraft] = useState({ ...DEFAULT_DRAFT });
  const [groupIdx, setGroupIdx] = useState(0);
  const [focusIdx, setFocusIdx] = useState(0);
  const [editor, setEditor] = useState(null);
  // editor: { kind: 'list'|'text'|'name'|'profiles'|'confirm', field?, value?, msg?, onYes? }
  const [catalog, setCatalog] = useState({ models: [], builds: [], devices: [] });
  const [preview, setPreview] = useState({ command: '', error: null });
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  const [activeProfile, setActiveProfile] = useState(null);
  const previewTimer = useRef(null);
  const prefilledRef = useRef(false);

  const fields = GROUPS[groupIdx][1];
  const flash = (text, ok = true) => setStatus({ text, ok });

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
      setCatalog((c) => ({ ...c, models: models || [], builds: buildList }));
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
  useEffect(() => {
    const lc = s.server.launchConfig;
    if (prefilledRef.current || !lc) return;
    prefilledRef.current = true;
    setDraft((d) => {
      const next = { ...d };
      for (const k of DRAFT_KEYS) {
        const v = lc[k];
        if (v === undefined || v === null || v === '') continue;
        next[k] = v;
      }
      return next;
    });
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
        setPreview(await client.postJson('/api/preview-command', draft));
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
    setBusy('launching');
    try {
      await client.postJson('/api/start', draft);
      flash('Launch requested \u2014 switching to Monitor');
      setTimeout(onLaunched, 250);
    } catch (err) {
      flash(`Launch failed: ${err.message}`, false);
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
          flash(`${labelOf(field)} must be a ${spec.int ? 'whole number' : 'number'} between ${spec.min} and ${spec.max}`, false);
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

  async function saveAs(name) {
    try {
      await saveProfile(client, name, draft);
      setActiveProfile(name);
      flash(`Saved profile "${name}"`);
    } catch (err) {
      flash(err.message, false);
    }
    setEditor(null);
  }

  function loadProfile(name) {
    listProfiles(client).then((p) => {
      const prof = p[name];
      if (!prof) return;
      // REPLACE, don't merge with the current draft: a profile is a complete
      // config. Merging would let a minimal profile (e.g. v1-migrated, or
      // `profile save -m X` with no devices) silently inherit the draft's
      // current GPU split and launch a different topology than saved.
      setDraft({ ...DEFAULT_DRAFT, ...prof });
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
    if (key.tab) setGroupIdx((g) => (g + 1) % GROUPS.length), setFocusIdx(0);
    else if (key.left) setGroupIdx((g) => (g - 1 + GROUPS.length) % GROUPS.length), setFocusIdx(0);
    else if (key.up || (input === 'k' && !key.ctrl)) setFocusIdx((i) => (i - 1 + n) % n);
    else if (key.down || (input === 'j' && !key.ctrl)) setFocusIdx((i) => (i + 1) % n);
    else if (key.return || key.right) {
      const [field, , kind] = fields[Math.min(focusIdx, n - 1)];
      if (kind === 'toggle') toggleField(field);
      else if (kind === 'list') setEditor({ kind: 'list', field });
      else setEditor({ kind: 'text', field, value: draft[field] == null ? '' : String(draft[field]) });
    } else if (input === 'p' && !key.ctrl) {
      setEditor({ kind: 'name', value: activeProfile || '' });
    } else if (input === 'l' && !key.ctrl) {
      listProfiles(client).then((p) => {
        if (Object.keys(p).length === 0) flash('No profiles saved yet \u2014 press p to save one', false);
        else setEditor({ kind: 'profiles', profiles: p });
      }).catch((err) => flash(err.message, false));
    } else if (input === 'd' && !key.ctrl && activeProfile) {
      setEditor({
        kind: 'confirm',
        msg: `Delete profile "${activeProfile}"?`,
        onYes: () => deleteProfile(client, activeProfile)
          .then(() => { setActiveProfile(null); flash(`Deleted "${activeProfile}"`); })
          .catch((err) => flash(err.message, false)),
      });
    } else if (input === 'b' && !key.ctrl) doLaunch();
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
      case 'deviceA':
      case 'deviceB': {
        const dv = catalog.devices.find((dd) => dd.id === v);
        return v
          ? h(Box, null,
            h(Text, null, v),
            dv ? h(Text, { dimColor: true }, `  ${dv.description}`) : h(Text, { dimColor: true }, '  (manual)'))
          : h(Text, { dimColor: true }, 'None');
      }
      case 'fa':
      case 'jinja':
      case 'mmprojEnabled':
      case 'reasoningPreserve':
        return h(Text, { color: v ? 'green' : 'gray' }, v ? 'on' : 'off');
      case 'argString':
      case 'chatTemplateFile':
      case 'mmprojPath':
      case 'rpcTarget':
      case 'specDraftModel':
        return h(Text, { color: v ? undefined : 'gray' }, v || '(none)');
      default:
        if (kind === 'num' || kind === 'float') return h(Text, { color: v == null ? 'gray' : undefined }, v == null ? '(unset)' : String(v));
        return h(Text, null, String(v ?? ''));
    }
  }

  const running = s.server.state !== 'stopped';

  const groupTabs = GROUPS.map(([g], i) =>
    h(Text, { key: g, bold: i === groupIdx, color: i === groupIdx ? 'cyan' : undefined, dimColor: i !== groupIdx },
      ` ${i === groupIdx ? '\u258F' : '\u25A1'}${g}`));

  const formRows = fields.map(([field, label], i) => {
    const focused = i === focusIdx && !editor;
    return h(Box, { key: field },
      h(Text, null,
        focused ? h(Text, { bold: true, color: 'green' }, '\u203A ') : '  ',
        h(Text, { bold: focused, dimColor: !focused }, pad(label, 15)),
      ),
      displayValue(field),
    );
  });

  let editorView = null;
  if (editor && editor.kind === 'list') {
    editorView = h(FuzzyList, {
      title: `Select ${labelOf(editor.field)}`,
      items: listOptions(editor.field),
      onSelect: (it) => { setDraft((d) => ({ ...d, [editor.field]: it.value })); setEditor(null); setActiveProfile(null); },
      onCancel: () => setEditor(null),
    });
  } else if (editor && editor.kind === 'text') {
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, `${labelOf(editor.field)} (Enter to commit, Esc to cancel):`),
      h(TextInput, {
        value: editor.value,
        onChange: (v) => setEditor((e) => ({ ...e, value: v })),
        onSubmit: (v) => commitText(editor.field, v),
      }),
    );
  } else if (editor && editor.kind === 'name') {
    editorView = h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, 'Profile name (Enter to save, Esc to cancel):'),
      h(TextInput, {
        value: editor.value,
        onChange: (v) => setEditor((e) => ({ ...e, value: v })),
        onSubmit: (v) => saveAs(v),
      }),
    );
  } else if (editor && editor.kind === 'profiles') {
    editorView = h(FuzzyList, {
      title: 'Load profile',
      items: Object.entries(editor.profiles).map(([name, p]) => ({
        label: name,
        hint: p.modelPath ? p.modelPath.split('/').pop() : '',
        value: name,
      })),
      onSelect: (it) => loadProfile(it.value),
      onCancel: () => setEditor(null),
    });
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

    s.conn !== 'live'
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

    h(KeymapBar, {
      hints: [
        ['\u2191/\u2193', 'field'], ['tab/\u2190', 'group'], ['Enter', 'edit'],
        ['p', 'save'], ['l', 'load'], ['d', 'del'], ['b', 'launch'], ['x', 'stop'],
      ],
    }),
  );
}
