'use strict';
// Path roots (lib/paths.js, 2026-10-13): ~, ${ROOT} and a models root, so a config or a profile is not one user's
// home directory -- and an absolute path means exactly what it did.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/paths');

const ctx = P.context({ pathRoots: { LLAMA: '~/src/llama.cpp', BUILD: '${LLAMA}/build', DATA: '${BIG}/data' }, modelsRoot: '~/models' }, { home: '/home/ann', env: { BIG: '/mnt/big', HF_HOME: '/hf' } });

test('expand: ~, config roots, environment variables; absolute paths untouched', () => {
    assert.strictEqual(P.expand('~/x/llama-server', ctx), '/home/ann/x/llama-server');
    assert.strictEqual(P.expand('~', ctx), '/home/ann');
    assert.strictEqual(P.expand('${BUILD}/bin/llama-server', ctx), '/home/ann/src/llama.cpp/build/bin/llama-server', 'a root may use an earlier root');
    assert.strictEqual(P.expand('${DATA}/a', ctx), '/mnt/big/data/a', 'and an environment variable');
    assert.strictEqual(P.expand('${HF_HOME}/hub', ctx), '/hf/hub');
    assert.strictEqual(P.expand('${MODELS}/q.gguf', ctx), '/home/ann/models/q.gguf', '${MODELS} is modelsRoot');
    // every path written before this existed
    for (const p of ['/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server', '/media/kyle/Lexar/models', '/data/models/a b.gguf', 'relative/x', '']) assert.strictEqual(P.expand(p, ctx), p);
    assert.strictEqual(P.expand('/a/~/b', ctx), '/a/~/b', '~ only at the start');
    // a variable nothing defines stays as written: the error then names it
    assert.strictEqual(P.expand('${NOPE}/x.gguf', ctx), '${NOPE}/x.gguf');
    assert.strictEqual(P.expand(null, ctx), null);
    // with no config at all: ~ and the environment still work
    assert.match(P.expand('~/x'), /^\/.+\/x$/);
});

test('expandModel: a relative model path is under modelsRoot, when there is one', () => {
    assert.strictEqual(P.expandModel('Qwen/q4.gguf', ctx), '/home/ann/models/Qwen/q4.gguf');
    assert.strictEqual(P.expandModel('/abs/q4.gguf', ctx), '/abs/q4.gguf');
    assert.strictEqual(P.expandModel('${NOPE}/q4.gguf', ctx), '${NOPE}/q4.gguf');
    assert.strictEqual(P.expandModel('Qwen/q4.gguf', P.context({}, { home: '/home/ann', env: {} })), 'Qwen/q4.gguf', 'no root: as written');
    assert.strictEqual(P.context({ pathRoots: { MODELS: '/m' } }, { home: '/h', env: {} }).modelsRoot, '/m', 'pathRoots.MODELS is a models root too');
});

test('collapse: the portable spelling of an absolute path, longest root first', () => {
    assert.strictEqual(P.collapse('/home/ann/models/Qwen/q4.gguf', ctx), '${MODELS}/Qwen/q4.gguf');
    assert.strictEqual(P.collapse('/home/ann/src/llama.cpp/build/bin/llama-server', ctx), '${BUILD}/bin/llama-server', 'BUILD is longer than LLAMA');
    assert.strictEqual(P.collapse('/home/ann/.cache/huggingface/hub/x', ctx), '~/.cache/huggingface/hub/x');
    assert.strictEqual(P.collapse('/data/models/x.gguf', ctx), '/data/models/x.gguf', 'under no root: unchanged');
    assert.strictEqual(P.collapse('/home/annie/x', ctx), '/home/annie/x', 'a prefix of a name is not a parent');
    for (const p of ['/home/ann/models/a.gguf', '/home/ann/src/llama.cpp/x', '/home/ann/y', '/mnt/big/data/z']) assert.strictEqual(P.expand(P.collapse(p, ctx), ctx), p, 'round trip');
});

test('commands: ~/ at a word start and defined ${NAME}s; collapseCommand is the inverse', () => {
    const cmd = "~/src/llama.cpp/build/bin/llama-server -m ${MODELS}/q4.gguf -ot 'blk\\.(1|2)\\.ffn=CUDA0' --chat-template-file=~/t.jinja -c 131072 ${NOPE}";
    assert.strictEqual(P.expandCommand(cmd, ctx), "/home/ann/src/llama.cpp/build/bin/llama-server -m /home/ann/models/q4.gguf -ot 'blk\\.(1|2)\\.ffn=CUDA0' --chat-template-file=/home/ann/t.jinja -c 131072 ${NOPE}");
    const abs = "/home/kyle/AI/x/llama-server -m '/home/kyle/.cache/q4.gguf' --port 8080";
    assert.strictEqual(P.expandCommand(abs, ctx), abs, 'nothing portable in it: the same string');
    const k = P.context({ modelsRoot: '/home/kyle/.cache' }, { home: '/home/kyle', env: {} });
    assert.strictEqual(P.collapseCommand(abs, k), "~/AI/x/llama-server -m '${MODELS}/q4.gguf' --port 8080");
    assert.strictEqual(P.expandCommand(P.collapseCommand(abs, k), k), abs);
});

test('profiles: expanded on the way out, and a load-and-save keeps the stored spelling', () => {
    const stored = { modelPath: '${MODELS}/q4.gguf', specDraftModel: 'draft.gguf', mmprojPath: '', chatTemplateFile: '~/t.jinja', strataBase: '', ctx: 4096,
        rawCommand: '~/b/llama-server -m ${MODELS}/q4.gguf', devices: [{ id: 'ROCm0' }] };
    const out = P.expandProfile(stored, ctx);
    assert.deepStrictEqual([out.modelPath, out.specDraftModel, out.chatTemplateFile, out.rawCommand],
        ['/home/ann/models/q4.gguf', '/home/ann/models/draft.gguf', '/home/ann/t.jinja', '/home/ann/b/llama-server -m /home/ann/models/q4.gguf']);
    assert.strictEqual(out.devices, stored.devices, 'nothing else is copied or changed');
    assert.strictEqual(stored.modelPath, '${MODELS}/q4.gguf', 'the stored object is not modified');
    const abs = { modelPath: '/data/models/a.gguf', rawCommand: '/x/llama-server -m /data/models/a.gguf', ctx: 1 };
    assert.strictEqual(P.expandProfile(abs, ctx), abs, 'an absolute profile is returned as it is');
    // the client sends back what it loaded, with one field edited
    const saved = P.keepPortable(stored, { ...out, ctx: 8192 }, ctx);
    assert.deepStrictEqual([saved.modelPath, saved.specDraftModel, saved.chatTemplateFile, saved.rawCommand, saved.ctx], ['${MODELS}/q4.gguf', 'draft.gguf', '~/t.jinja', '~/b/llama-server -m ${MODELS}/q4.gguf', 8192]);
    // a field the user really changed is stored as sent
    assert.strictEqual(P.keepPortable(stored, { ...out, modelPath: '/elsewhere/b.gguf' }, ctx).modelPath, '/elsewhere/b.gguf');
    // an absolute profile is never rewritten into a portable one
    assert.deepStrictEqual(P.keepPortable(abs, { ...abs }, ctx), abs);
    assert.deepStrictEqual(P.keepPortable(null, abs, ctx), abs);
});

// --- the optional profile-store migration (tools/migrate-profile-paths.js) and the example config ---
const fs = require('fs');
const path = require('path');
const { migrate } = require('../tools/migrate-profile-paths');

test('migrate: a store with absolute paths in its portable form; a copy, checked to expand back, never in place', () => {
    const k = P.context({ pathRoots: { LLAMA: '/home/kyle/AI/llama-official' }, modelsRoot: '/data/models' }, { home: '/home/kyle', env: {} });
    const doc = { version: 3, profiles: {
        a: { config: { modelPath: '/data/models/A/a.gguf', specDraftModel: '', rawCommand: "/home/kyle/AI/llama-official/build/bin/llama-server -m /data/models/A/a.gguf -ot 'blk\\.1=CUDA0' --port 8080", devices: [{ id: 'ROCm0' }] }, savedAt: 1 },
        b: { config: { engine: 'strata', strataBase: '/home/kyle/AI/Strata-0.1.32/strata-iq3_xxs.json', chatTemplateFile: '/media/kyle/Lexar/t.jinja' } },
        c: { config: { modelPath: '${MODELS}/already.gguf' } },
        d: {},
    } };
    const before = JSON.stringify(doc);
    const r = migrate(doc, k);
    assert.strictEqual(JSON.stringify(doc), before, 'the document passed in is not modified');
    assert.deepStrictEqual(r.changes.map((c) => [c.profile, c.field, c.to]), [
        ['a', 'modelPath', '${MODELS}/A/a.gguf'],
        ['a', 'rawCommand', "${LLAMA}/build/bin/llama-server -m ${MODELS}/A/a.gguf -ot 'blk\\.1=CUDA0' --port 8080"],
        ['b', 'strataBase', '~/AI/Strata-0.1.32/strata-iq3_xxs.json'],
    ]);
    assert.deepStrictEqual(r.kept.map((x) => [x.profile, x.field, x.value]), [['b', 'chatTemplateFile', '/media/kyle/Lexar/t.jinja']], 'what a new machine would still have to provide is listed');
    // the migrated store is the same store to this machine: every profile expands back to what it was
    for (const [name, p] of Object.entries(doc.profiles)) assert.deepStrictEqual(P.expandProfile(r.doc.profiles[name].config || {}, k), P.expandProfile(p.config || {}, k), name);
    assert.strictEqual(r.doc.profiles.c.config.modelPath, '${MODELS}/already.gguf', 'an already portable path is left alone');
    assert.deepStrictEqual(r.doc.profiles.a.config.devices, [{ id: 'ROCm0' }]);
    assert.strictEqual(r.doc.profiles.a.savedAt, 1);
});

test('dashboard.config.example.json: usable unchanged on a fresh machine, and names nobody\'s hardware', () => {
    const file = path.join(__dirname, '..', 'dashboard.config.example.json');
    const text = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(text);
    const fresh = P.context(cfg, { home: '/home/someone', env: {} });
    const builds = cfg.llamaServerBuilds.map((b) => P.expand(b.path, fresh));
    assert.deepStrictEqual(builds, ['/home/someone/llama.cpp/build/bin/llama-server']);
    assert.strictEqual(fresh.modelsRoot, '/home/someone/models');
    for (const b of builds) assert.ok(!b.includes('${') && !b.includes('~'), 'every root it uses is defined in the file itself');
    assert.ok(!/\/home\/|\/media\/|\/data\//.test(text), 'no absolute path of any machine');
    assert.ok(!/RTX|GeForce|Radeon|RX \d|CUDA\d|ROCm\d|Vulkan\d|laptop/i.test(text), 'no card, device id or host of any machine');
    assert.deepStrictEqual([cfg.rpcWorkers, cfg.strataInstalls, cfg.deviceNames, cfg.internalRowVariants, cfg.reliabilityNotes, cfg.queue], [{}, [], {}, [], [], {}]);
});
