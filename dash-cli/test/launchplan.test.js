import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStrataConfig, strataLaunchConfig, profileLaunchPlan, fmtCtx, ago, cardsCell, profileModelLabel,
  modelKnown, profileRow, filterRows, profileColumns, fit, planCards, normalizeBusy, busyText,
  isCardBusyError, isRunningError, runningSummary, launchRisks, wrapLines, PROFILE_GUTTER,
  profileListRows, strataVersionOf, isUnavailableHereError, availabilityFromError, startBody, devicesListingNote, fitLabel,
} from '../src/launchplan.js';

// Shapes copied from the dashboard: a two-card llama-server profile as the
// web saves it, a Strata-engine profile, /api/models entries, a busy entry
// from lib/launchguard.js.
const TWO_CARD = {
  modelPath: '/models/Qwen3.8-27B-UD-Q4_K_XL.gguf', build: 'all', ctx: 131072, ngl: 999, launchMode: 'local-multi-gpu',
  devices: [
    { id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX', share: 75 },
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', share: 25 },
  ],
  fa: true, cacheK: 'f16', cacheV: 'f16', specType: 'draft-mtp,ngram-mod', specDraftNMax: 2, specDraftDevice: 'ROCm0',
  jinja: true, verbosity: null, argString: null,
  rawCommand: '/x/llama-server -m /models/other.gguf', tuningNote: 'best two-card config',
};
const STRATA = {
  engine: 'strata', strataBase: '/home/kyle/AI/Strata-0.1.32/strata-coder-iq1_m-262k-int8.json',
  rawCommand: '/home/kyle/AI/Strata-0.1.32/queue-serve.sh /home/kyle/AI/Strata-0.1.32/strata-coder-iq1_m-262k-int8.json --port 8080',
  temp: 1, topK: 20, topP: 0.95, tuningNote: 'Strata on the XTX',
};
const MODELS = [
  { name: 'Qwen3.8-27B-UD-Q4_K_XL.gguf', path: '/models/Qwen3.8-27B-UD-Q4_K_XL.gguf', realPath: '/data/models/Qwen3.8-27B-UD-Q4_K_XL.gguf', aliases: ['/data/models/Qwen3.8-27B-UD-Q4_K_XL.gguf', '/media/x/Qwen3.8-27B-UD-Q4_K_XL.gguf'], kind: 'model' },
  { name: 'mmproj-F16.gguf', path: '/models/mmproj-F16.gguf', kind: 'mmproj' },
];
const BUSY = { lane: 'local-3060', device: 'CUDA0', card: 'RTX 3060', cardKey: 'rtx3060', itemId: 879, label: 'idle-qwen38-27b-80k' };

test('fmtCtx / ago: the compact list cells', () => {
  assert.equal(fmtCtx(131072), '131k');
  assert.equal(fmtCtx(65536), '65k');
  assert.equal(fmtCtx(262144), '262k');
  assert.equal(fmtCtx(1048576), '1M');
  assert.equal(fmtCtx(512), '512');
  assert.equal(fmtCtx(null), '—');
  assert.equal(fmtCtx(''), '—');
  assert.equal(ago(20 * 1000), 'just now');
  assert.equal(ago(5 * 60000), '5m ago');
  assert.equal(ago(5 * 3600000), '5h ago');
  assert.equal(ago(72 * 3600000), '3d ago');
});

test('cardsCell / profileModelLabel: either engine, either device shape', () => {
  // No topology (an older server): the server's placement wording, from the names the profile stored.
  assert.equal(cardsCell(TWO_CARD), 'RX 7900 XTX + RTX 3060, 3:1');
  assert.equal(cardsCell({ devices: [{ id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX', share: 100 }] }), 'RX 7900 XTX alone', 'a lone device shows no share');
  assert.equal(cardsCell({ devices: [{ id: 'ROCm0', enabled: false }] }), 'auto', 'disabled rows are not part of the launch');
  assert.equal(cardsCell({ deviceA: 'Vulkan0', rpcTarget: 'laptop', tensorSplit: 60 }), 'Vulkan0 + laptop (RPC), 3:2', 'legacy fields');
  assert.equal(cardsCell(STRATA), 'Strata engine', 'a Strata profile names no card: the engine places itself');
  assert.equal(profileModelLabel(TWO_CARD), 'Qwen3.8-27B-UD-Q4_K_XL');
  assert.equal(profileModelLabel({ modelPath: '/m/Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf' }), 'Flash-Next-UD-Q2_K_XL', 'split suffix dropped');
  assert.equal(profileModelLabel(STRATA), 'strata coder-iq1_m-262k-int8');
  assert.equal(profileModelLabel({}), '(no model)');
});

test('modelKnown matches a path, its resolved path or an alias; unknown without a catalog', () => {
  assert.equal(modelKnown(MODELS, '/models/Qwen3.8-27B-UD-Q4_K_XL.gguf'), true);
  assert.equal(modelKnown(MODELS, '/data/models/Qwen3.8-27B-UD-Q4_K_XL.gguf'), true, 'realPath');
  assert.equal(modelKnown(MODELS, '/media/x/Qwen3.8-27B-UD-Q4_K_XL.gguf'), true, 'alias');
  assert.equal(modelKnown(MODELS, '/models/gone.gguf'), false);
  assert.equal(modelKnown([], '/models/gone.gguf'), null, 'catalog not loaded: no verdict');
  assert.equal(modelKnown(MODELS, ''), null);
});

test('profileRow: columns, missing-file and never-used markers, Strata profiles', () => {
  const now = 1_000_000_000_000;
  const ok = profileRow({ name: 'daily', config: TWO_CARD, savedAt: 1, lastLoadedAt: now - 3 * 3600000 }, { models: MODELS, now });
  assert.equal(ok.model, 'Qwen3.8-27B-UD-Q4_K_XL');
  assert.equal(ok.ctx, '131k');
  assert.equal(ok.cards, 'RX 7900 XTX + RTX 3060, 3:1');
  assert.deepEqual(ok.avail, { status: 'ready', reason: '', placement: null }, 'no availability from the server: ready');
  assert.equal(ok.runnable, true);
  assert.equal(ok.build, 'all');
  assert.equal(ok.missing, false);
  assert.equal(ok.neverUsed, false);
  assert.equal(ok.status, '3h ago');
  assert.equal(ok.note, 'best two-card config');

  const gone = profileRow({ name: 'old', config: { ...TWO_CARD, modelPath: '/models/deleted-Q6.gguf' }, lastLoadedAt: null }, { models: MODELS, now });
  assert.equal(gone.missing, true);
  assert.equal(gone.missingWhy, 'model file not found');
  assert.equal(gone.status, 'MISSING');
  assert.equal(gone.neverUsed, true);
  assert.equal(gone.used, 'never used');

  const unknown = profileRow({ name: 'old', config: { ...TWO_CARD, modelPath: '/models/deleted-Q6.gguf' } }, { models: [], now });
  assert.equal(unknown.missing, false, 'no catalog -> no marker');
  assert.equal(unknown.status, 'never used');

  const empty = profileRow({ name: 'bare', config: { ctx: 4096 }, lastLoadedAt: 5 }, { models: MODELS, now });
  assert.equal(empty.missing, true);
  assert.equal(empty.missingWhy, 'no model set');

  const strata = profileRow({ name: 's', config: STRATA, lastLoadedAt: now - 60000 }, { models: MODELS, strata: [{ path: STRATA.strataBase, maxContext: 262144 }], now });
  assert.equal(strata.strata, true);
  assert.equal(strata.build, 'strata');
  assert.equal(strata.missing, false);
  assert.equal(strata.ctx, '262k', 'context from the base config list when the server gives it');
  assert.equal(profileRow({ name: 's', config: STRATA }, { strata: [{ path: STRATA.strataBase }] }).ctx, '—');
  assert.equal(profileRow({ name: 's', config: STRATA }, { strata: [] }).missingWhy, 'Strata base config not found');
  assert.equal(profileRow({ name: 's', config: STRATA }, { strata: null }).missing, false, 'list not loaded -> no marker');
});

test('filterRows: whole-word matches keep list order, fuzzy matches follow; columns fit the width', () => {
  const rows = [
    { name: 'bench · Strata Coder', model: 'strata coder', ctx: '—', cards: '7900 XTX', build: 'strata', status: '1d ago' },
    { name: 'opt · Terse-Coder Q4_K_M · 128k', model: 'Terse-Coder.Q4_K_M', ctx: '131k', cards: '7900 XTX 75 · 3060 25', build: 'all', status: 'never used' },
    { name: 'daily · Qwen3.8-27B UD-Q4_K_XL', model: 'Qwen3.8-27B-UD-Q4_K_XL', ctx: '131k', cards: '7900 XTX', build: 'all', status: 'MISSING' },
  ];
  assert.equal(filterRows(rows, ''), rows);
  assert.deepEqual(filterRows(rows, 'coder').map((r) => r.name), [rows[0].name, rows[1].name], 'list (MRU) order kept');
  assert.deepEqual(filterRows(rows, 'terse 128').map((r) => r.name), [rows[1].name], 'every word must appear');
  assert.deepEqual(filterRows(rows, 'missing').map((r) => r.name), [rows[2].name], 'the status column is searchable');
  assert.deepEqual(filterRows(rows, 'q4').map((r) => r.name), [rows[1].name, rows[2].name], 'an exact hit shows no fuzzy noise');
  assert.deepEqual(filterRows(rows, 'dlyq4').map((r) => r.name), [rows[2].name], 'subsequence fallback when nothing matches as written');
  assert.deepEqual(filterRows(rows, 'zzzz'), []);

  for (const cols of [80, 100, 132, 200]) {
    const w = profileColumns(rows, cols);
    const used = PROFILE_GUTTER + w.name + 1 + w.model + 1 + w.ctx + 1 + w.cards + (w.build ? 1 + w.build : 0) + 1 + w.status;
    assert.ok(used <= cols, `${cols} cols: row is ${used} wide`);
    assert.ok(w.name >= 10 && w.model >= 10 && w.cards >= 8);
  }
  assert.equal(profileColumns(rows, 80).build, 0, 'build column dropped on a narrow terminal');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('ab', 4), 'ab  ');
});

test('strataLaunchConfig: engine + base + overrides only, temp sent as temperature, never rawCommand', () => {
  assert.equal(isStrataConfig(STRATA), true);
  assert.equal(isStrataConfig(TWO_CARD), false);
  assert.deepEqual(strataLaunchConfig(STRATA), {
    engine: 'strata', strataBase: STRATA.strataBase, temperature: 1, topK: 20, topP: 0.95,
  });
  assert.deepEqual(strataLaunchConfig({ ...STRATA, maxContext: 131072, kv: 'int8', port: 8095, temp: null }), {
    engine: 'strata', strataBase: STRATA.strataBase, maxContext: 131072, kv: 'int8', topK: 20, topP: 0.95, port: 8095,
  });
});

test('profileLaunchPlan: the same body the editor would send (no rawCommand, verbosity floor), legacy devices converted by the server', async () => {
  const posts = [];
  const client = {
    postJson: async (p, body) => {
      posts.push([p, body]);
      return { command: '', devices: [{ id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 60 }, { worker: 'laptop', share: 40, id: 'RPC0' }], warnings: ['moved from Vulkan0 to Vulkan1'] };
    },
  };
  const plan = await profileLaunchPlan(client, TWO_CARD);
  assert.equal(plan.problem, null);
  assert.equal(posts.length, 0, 'a profile with `devices` needs no conversion call');
  assert.equal('rawCommand' in plan.config, false);
  assert.equal('launchMode' in plan.config, false);
  assert.equal(plan.config.verbosity, 3);
  assert.equal(plan.config.modelPath, TWO_CARD.modelPath);
  assert.equal(plan.config.specDraftDevice, 'ROCm0');
  assert.deepEqual(plan.config.devices, [
    { id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX', enabled: true, share: 75 },
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', enabled: true, share: 25 },
  ]);

  const legacy = await profileLaunchPlan(client, { modelPath: '/m/a.gguf', build: 'vulkan', ctx: 8192, ngl: 99, deviceA: 'Vulkan0', rpcTarget: 'laptop', tensorSplit: 60, transport: 'TB4' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], '/api/preview-command');
  assert.deepEqual(legacy.config.devices, [
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', enabled: true, share: 60 },
    { worker: 'laptop', enabled: true, share: 40 },
  ]);
  assert.equal(legacy.config.transport, 'TB4');
  for (const k of ['deviceA', 'rpcTarget', 'tensorSplit']) assert.equal(k in legacy.config, false, `${k} not sent`);
  assert.deepEqual(legacy.notes, ['moved from Vulkan0 to Vulkan1']);

  assert.match((await profileLaunchPlan(client, { ctx: 4096 })).problem, /no model set/);
  assert.match((await profileLaunchPlan(client, { ...TWO_CARD, devices: [{ id: 'ROCm0', share: 60 }, { id: 'CUDA0', share: 60 }] })).problem, /total 120%/);
  const strata = await profileLaunchPlan(client, STRATA);
  assert.equal(strata.config.engine, 'strata');
  assert.equal(strata.problem, null);
  assert.match((await profileLaunchPlan(client, { engine: 'strata' })).problem, /no base config/);
});

test('planCards: the resolved plan from the preview wins; shares as percentages', () => {
  assert.deepEqual(planCards([
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', share: 60 },
    { worker: 'laptop', share: 40, id: 'RPC0' },
  ], TWO_CARD), [
    { text: 'RX 7900 XTX (Vulkan1)', share: '60%' },
    { text: 'RPC laptop (RPC0)', share: '40%' },
  ]);
  assert.deepEqual(planCards(null, TWO_CARD), [
    { text: 'RX 7900 XTX (ROCm0)', share: '75%' },
    { text: 'RTX 3060 (CUDA0)', share: '25%' },
  ]);
  assert.deepEqual(planCards([], { devices: [{ id: 'ROCm0' }, { id: 'CUDA0', enabled: false }] }), [{ text: 'ROCm0', share: '' }]);
  assert.deepEqual(planCards(undefined, { devices: [{ id: 'ROCm0' }, { id: 'CUDA0' }] }).map((c) => c.share), ['auto', 'auto']);
  assert.deepEqual(planCards(null, {}), []);
});

test('busy cards: normalized defensively, absent field = free; the 409 is recognized by status + code', () => {
  assert.deepEqual(normalizeBusy(undefined), [], 'older server: no busy field');
  assert.deepEqual(normalizeBusy('nope'), []);
  assert.deepEqual(normalizeBusy([BUSY, null, 'x']), [{ lane: 'local-3060', device: 'CUDA0', card: 'RTX 3060', itemId: 879, label: 'idle-qwen38-27b-80k' }]);
  assert.equal(busyText(normalizeBusy([BUSY])[0]), 'RTX 3060 (CUDA0) — queue item 879 “idle-qwen38-27b-80k” · lane local-3060');
  assert.equal(busyText(normalizeBusy([{ device: 'ROCm0' }])[0]), 'ROCm0 — a queue item', 'partial entries still read');

  const err = Object.assign(new Error('Card busy: the RTX 3060 is running queue item 879'), { status: 409, data: { code: 'CARD_BUSY', busy: [BUSY] } });
  assert.equal(isCardBusyError(err), true);
  assert.equal(isCardBusyError(Object.assign(new Error('x'), { status: 409, data: {} })), false);
  assert.equal(isCardBusyError(Object.assign(new Error('x'), { status: 400, data: { code: 'CARD_BUSY' } })), false);
  assert.equal(isCardBusyError(new Error('Card busy')), false, 'never matched on message text');
  assert.equal(isRunningError(Object.assign(new Error('Running'), { status: 400 })), true);
  assert.equal(isRunningError(Object.assign(new Error('Model not found'), { status: 400 })), false);
});

test('runningSummary / launchRisks: what is up, and what a launch would cost', () => {
  const now = 2_000_000;
  const server = { state: 'ready', model: 'Qwen3.8-27B-UD-Q4_K_XL.gguf', launchConfig: TWO_CARD, launchCommand: '/x/llama-server --port 8080' };
  const up = runningSummary(server, now - 3723000, now);
  assert.equal(up.active, true);
  assert.equal(up.model, 'Qwen3.8-27B-UD-Q4_K_XL');
  assert.equal(up.ctx, 131072);
  assert.equal(up.cards, 'RX 7900 XTX + RTX 3060, 3:1');
  assert.equal(up.uptime, '01:02:03');
  assert.equal(runningSummary(server, null, now).uptime, null, 'already running when the TUI connected: unknown');
  const loading = runningSummary({ ...server, state: 'loading', loadStartTime: now - 12000 }, null, now);
  assert.equal(loading.loading, true);
  assert.equal(loading.loadingFor, 12);
  const idle = runningSummary({ state: 'stopped', model: '', launchConfig: null, external: { port: 8080, model: 'queue-model' } }, null, now);
  assert.equal(idle.active, false);
  assert.equal(idle.external.port, 8080);

  assert.deepEqual(launchRisks({ running: idle, port: 8095 }), []);
  assert.deepEqual(launchRisks({ running: idle, port: 8080 }).map((r) => r.kind), ['port']);
  const risks = launchRisks({ running: up, busy: normalizeBusy([BUSY]), missingWhy: 'model file not found', filePath: '/m/x.gguf' });
  assert.deepEqual(risks.map((r) => r.kind), ['stop', 'busy', 'missing']);
  assert.match(risks[0].text, /stop the running server \(Qwen3\.8-27B-UD-Q4_K_XL, up 01:02:03\)/);
  assert.match(risks[1].text, /take RTX 3060 \(CUDA0\) — queue item 879/);
  assert.match(risks[2].text, /model file not found: \/m\/x\.gguf/);
});

test('wrapLines: greedy word wrap with a line cap (the confirm panel sizes its command to the screen)', () => {
  assert.deepEqual(wrapLines('aaa bbb ccc ddd', 8), ['aaa bbb', 'ccc ddd']);
  assert.deepEqual(wrapLines('aaa bbb ccc ddd eee fff', 8, 2), ['aaa bbb', 'ccc ddd…']);
  assert.deepEqual(wrapLines('0123456789abcdef xy', 8), ['01234567', '89abcdef', 'xy'], 'a word longer than the line is cut');
  assert.deepEqual(wrapLines('', 20), []);
  assert.ok(wrapLines('x '.repeat(200), 10, 3).every((l) => l.length <= 10));
});

test('a profile note survives the editor round trip (configToDraft -> draftToConfig)', async () => {
  const { configToDraft, draftToConfig } = await import('../src/launchconfig.js');
  const out = draftToConfig(configToDraft(TWO_CARD));
  assert.equal(out.tuningNote, 'best two-card config');
  assert.equal('rawCommand' in out, false);
  assert.equal('tuningNote' in draftToConfig(configToDraft({ modelPath: '/m/a.gguf' })), false, 'not invented when absent');
});

// GET /api/strata/configs from a dashboard configured with two Strata installs
// (2026-10-13): one list across both, each entry naming its install and that
// install's version. Paths are the two real installs' layout.
const STRATA_TWO_INSTALLS = {
  dir: '/home/kyle/AI/Strata-0.1.32',
  serveScript: '/home/kyle/AI/Strata-0.1.32/queue-serve.sh',
  configs: [
    { path: '/home/kyle/AI/Strata-0.1.32/strata-coder-iq1_m-262k-int8.json', name: 'strata-coder-iq1_m-262k-int8.json', maxContext: '262144', install: '/home/kyle/AI/Strata-0.1.32', version: '0.1.32' },
    { path: '/home/kyle/AI/Strata-0.1.32/strata-iq3_xxs.json', name: 'strata-iq3_xxs.json', maxContext: '131072', install: '/home/kyle/AI/Strata-0.1.32', version: '0.1.32' },
    { path: '/home/kyle/AI/Strata-0.1.43.1/strata-iq3_xxs-2gpu-split27-trim-pw2.json', name: 'strata-iq3_xxs-2gpu-split27-trim-pw2.json', maxContext: '131072', install: '/home/kyle/AI/Strata-0.1.43.1', version: '0.1.43.1' },
    { path: '/home/kyle/AI/Strata-0.1.43.1/strata-iq3_xxs.json', name: 'strata-iq3_xxs.json', maxContext: '131072', install: '/home/kyle/AI/Strata-0.1.43.1', version: '0.1.43.1' },
  ],
  installs: [
    { dir: '/home/kyle/AI/Strata-0.1.32', version: '0.1.32', serveScript: '/home/kyle/AI/Strata-0.1.32/queue-serve.sh', configs: 2 },
    { dir: '/home/kyle/AI/Strata-0.1.43.1', version: '0.1.43.1', serveScript: '/home/kyle/AI/Strata-0.1.43.1/queue-serve.sh', configs: 2 },
  ],
};
const strataProfile = (base) => ({ engine: 'strata', strataBase: base, rawCommand: `${base.replace(/\/[^/]+$/, '')}/queue-serve.sh ${base} --port 8080` });

test('Strata profiles across installs: found in whichever install holds the base config, with that install\'s version', () => {
  const entries = [
    { name: 'opt · Strata 0.1.43.1 · one card', config: strataProfile('/home/kyle/AI/Strata-0.1.43.1/strata-iq3_xxs.json'), lastLoadedAt: 3 },
    { name: 'opt · Strata 0.1.43.1 · 2 cards', config: strataProfile('/home/kyle/AI/Strata-0.1.43.1/strata-iq3_xxs-2gpu-split27-trim-pw2.json'), lastLoadedAt: 2 },
    { name: 'bench · Strata IQ3_XXS', config: strataProfile('/home/kyle/AI/Strata-0.1.32/strata-iq3_xxs.json'), lastLoadedAt: 1 },
    { name: 'gone', config: strataProfile('/home/kyle/AI/Strata-0.1.40.3/strata-iq3_xxs.json'), lastLoadedAt: 1 },
  ];
  const rows = profileListRows(entries, { strata: STRATA_TWO_INSTALLS.configs });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  for (const name of ['opt · Strata 0.1.43.1 · one card', 'opt · Strata 0.1.43.1 · 2 cards']) {
    assert.equal(by[name].missing, false, `${name}: its base config is in the second install`);
    assert.equal(by[name].missingWhy, '');
    assert.notEqual(by[name].status, 'MISSING');
    assert.equal(by[name].strataVersion, '0.1.43.1');
    assert.equal(by[name].ctx, '131k', 'context from that install\'s entry');
  }
  // the same file name in both installs: each profile gets its own install's entry
  assert.equal(by['bench · Strata IQ3_XXS'].missing, false);
  assert.equal(by['bench · Strata IQ3_XXS'].strataVersion, '0.1.32');
  // a base config in no configured install is still missing, and says so
  assert.equal(by.gone.missing, true);
  assert.equal(by.gone.missingWhy, 'Strata base config not found');
  assert.equal(by.gone.status, 'MISSING');
  assert.equal(by.gone.strataVersion, '0.1.40.3', 'the version is still read off its directory');
  // searchable by version; the build column stays "strata"
  assert.deepEqual(filterRows(rows, '0.1.43.1').map((r) => r.name), ['opt · Strata 0.1.43.1 · one card', 'opt · Strata 0.1.43.1 · 2 cards']);
  assert.deepEqual(filterRows(rows, 'strata 0.1.32').map((r) => r.name), ['bench · Strata IQ3_XXS']);
  assert.ok(rows.every((r) => r.build === 'strata'));

  // An older server lists one directory and nothing else (no `installs`): a base config outside it is not in that
  // list either way, so it is not called missing; one inside it still is.
  const oldList = STRATA_TWO_INSTALLS.configs.filter((c) => c.install === STRATA_TWO_INSTALLS.dir).map(({ path, name, maxContext }) => ({ path, name, maxContext }));
  const old = (base) => profileRow({ name: 'x', config: strataProfile(base) }, { strata: oldList, strataScope: STRATA_TWO_INSTALLS.dir });
  assert.equal(old('/home/kyle/AI/Strata-0.1.43.1/strata-iq3_xxs.json').missing, false, 'outside the one directory that server lists: unknown, not missing');
  assert.equal(old('/home/kyle/AI/Strata-0.1.32/strata-deleted.json').missingWhy, 'Strata base config not found');
  assert.equal(old('/home/kyle/AI/Strata-0.1.32/strata-iq3_xxs.json').missing, false);
  assert.equal(old('/home/kyle/AI/Strata-0.1.32-old/strata-iq3_xxs.json').missing, false, 'a sibling directory that merely starts the same is outside it');
});

test('strataVersionOf: the server\'s version, else the install directory\'s own name, else nothing', () => {
  assert.equal(strataVersionOf({ version: '0.1.43.1', install: '/opt/strata' }, '/opt/strata/strata-a.json'), '0.1.43.1');
  assert.equal(strataVersionOf({ version: null, install: '/home/u/AI/Strata-0.1.32' }, '/home/u/AI/Strata-0.1.32/strata-a.json'), '0.1.32');
  assert.equal(strataVersionOf(null, '/home/u/AI/Strata-0.1.43.1/strata-a.json'), '0.1.43.1');
  assert.equal(strataVersionOf(null, '/srv/strata_v2.0/strata-a.json'), '2.0');
  assert.equal(strataVersionOf(null, '/opt/strata/strata-a.json'), '', 'a directory with no version in its name');
  assert.equal(strataVersionOf(null, '/opt/strata/strata-iq3_xxs-128k.json'), '', 'never read off the config file\'s own name');
  assert.equal(strataVersionOf(null, ''), '');
});

test('the unavailable-here refusal: recognized by status + code; its override is a flag on the request only', () => {
  const err = Object.assign(new Error('This machine cannot run this launch as saved: Needs RTX 3060.'),
    { status: 409, data: { code: 'UNAVAILABLE_HERE', availability: { status: 'unavailable', reason: 'Needs RTX 3060.' } } });
  assert.equal(isUnavailableHereError(err), true);
  assert.equal(isCardBusyError(err), false, 'not the busy-card refusal');
  assert.equal(isUnavailableHereError(Object.assign(new Error('x'), { status: 409, data: { code: 'CARD_BUSY' } })), false);
  assert.equal(isUnavailableHereError(Object.assign(new Error('x'), { status: 400, data: { code: 'UNAVAILABLE_HERE' } })), false);
  assert.equal(isUnavailableHereError(new Error('unavailable')), false, 'never matched on message text');
  assert.deepEqual(availabilityFromError(err), { status: 'unavailable', reason: 'Needs RTX 3060.', placement: null });
  const bare = Object.assign(new Error('cannot run here'), { status: 409, data: { code: 'UNAVAILABLE_HERE' } });
  assert.deepEqual(availabilityFromError(bare), { status: 'unavailable', reason: 'cannot run here', placement: null }, 'no reason in the body: the error text');

  const cfg = { modelPath: '/m.gguf', ctx: 4096, devices: [{ id: 'CUDA0', share: 100 }] };
  assert.deepEqual(startBody(cfg), cfg, 'no answers collected: the config as it stands');
  assert.notEqual(startBody(cfg), cfg, 'always a copy');
  assert.deepEqual(startBody(cfg, { allowUnavailable: true }), { ...cfg, allowUnavailable: true });
  assert.equal('force' in startBody(cfg, { allowUnavailable: true }), false, 'the unavailable override is not the busy-card one');
  assert.deepEqual(startBody(cfg, { force: true }), { ...cfg, force: true });
  assert.equal('allowUnavailable' in startBody(cfg, { force: true }), false, 'and the other way round');
  assert.deepEqual(startBody(cfg, { force: true, allowUnavailable: true }), { ...cfg, force: true, allowUnavailable: true });
  assert.deepEqual(cfg, { modelPath: '/m.gguf', ctx: 4096, devices: [{ id: 'CUDA0', share: 100 }] }, 'the config itself never gains a flag');
  // a flag that leaked into a stored config is not resent on its own
  assert.deepEqual(startBody({ ...cfg, force: true, allowUnavailable: true }), cfg);
});

test('devicesListingNote: a device list served from the dashboard\'s cache says so, with its age and why', () => {
  const now = 1_800_000_000_000;
  assert.equal(devicesListingNote({ devices: [], cards: [] }, now), '', 'an older server says nothing: no note');
  assert.equal(devicesListingNote({ cached: false, probed: true, cachedAt: now, ageMs: 0 }, now), '', 'probed for this request');
  assert.equal(devicesListingNote({ cached: true, probed: false, cachedAt: now - 12 * 60000, ageMs: 12 * 60000, note: 'not re-probed: a benchmark is running on a local card' }, now),
    'device list from 12m ago (cached) — not re-probed: a benchmark is running on a local card');
  assert.equal(devicesListingNote({ cached: true, cachedAt: now - 3 * 3600000 }, now), 'device list from 3h ago (cached)', 'age from cachedAt when ageMs is absent');
  assert.equal(devicesListingNote({ cached: true, ageMs: 5000 }, now), 'device list from just now (cached)');
  assert.equal(devicesListingNote({ cached: true, cachedAt: null, ageMs: null }, now), 'device list (cached)');
  // a probe that failed just now no longer empties the table: the last good listing, and the reason
  assert.equal(devicesListingNote({ cached: true, ageMs: 40 * 60000, error: 'timed out', note: 'ignored when there is an error' }, now),
    'device list from 40m ago (cached) — the probe just now failed: timed out');
  assert.equal(devicesListingNote(null, now), '');
});

test('fitLabel: a placement cell cut to its column keeps the card ordinal, padded like fit()', () => {
  assert.equal(fitLabel('RX 7900 XTX #2 alone', 12), 'RX 7900… #2 ');
  assert.equal(fitLabel('RX 7900 XTX #1 alone', 12), 'RX 7900… #1 ');
  assert.equal(fit('RX 7900 XTX #2 alone', 12), 'RX 7900 XTX…', 'the plain cut loses it');
  assert.equal(fitLabel('RX 7900 XTX #2 alone', 24), 'RX 7900 XTX #2 alone    ');
  assert.equal(fitLabel('2x RX 7900 XTX, 1:1', 9), '2x RX 79…', 'no ordinal: as fit()');
  assert.equal(fitLabel('x', 0), '');
});
