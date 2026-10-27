'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/mmproj');

// The rig's real layout (2026-09-14).
const HF = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots';
const LOCAL = '/home/kyle/AI/experiment-1/models';
const CANDIDATES = [
    { path: `${HF}/27af057ecb382ddfea5d12837360a8980560e3ed/mmproj-F16.gguf`, mtimeMs: 100 },
    { path: `${HF}/4ca720788d1e01f1bff70c033e0d0028fd02e502/mmproj-F16.gguf`, mtimeMs: 300 },
    { path: '/home/kyle/.cache/huggingface/hub/models--other--Model-GGUF/snapshots/abc/mmproj-F16.gguf', mtimeMs: 999 },
    { path: `${LOCAL}/qwen-3.8-mmproj-F16.gguf`, mtimeMs: 50 },
];

test('HF cache: the model\'s own snapshot wins', () => {
    assert.equal(M.pickMmproj(`${HF}/27af057ecb382ddfea5d12837360a8980560e3ed/Qwen3.8-27B-UD-Q6_K_XL.gguf`, CANDIDATES),
        `${HF}/27af057ecb382ddfea5d12837360a8980560e3ed/mmproj-F16.gguf`);
});

test('HF cache: a snapshot without one borrows the newest from the same repo, never another repo', () => {
    assert.equal(M.pickMmproj(`${HF}/fe1e2a23d973adb629709749dc4f6756df66ef10/Qwen3.8-27B-Q8_0.gguf`, CANDIDATES),
        `${HF}/4ca720788d1e01f1bff70c033e0d0028fd02e502/mmproj-F16.gguf`);
    assert.equal(M.pickMmproj('/home/kyle/.cache/huggingface/hub/models--x--None-GGUF/snapshots/r/None-Q4.gguf', CANDIDATES), null);
});

test('plain folder: matched by model family, F16 preferred', () => {
    assert.equal(M.pickMmproj(`${LOCAL}/Qwen3.8-27B-UD-Q3_K_XL.gguf`, CANDIDATES), `${LOCAL}/qwen-3.8-mmproj-F16.gguf`);
    assert.equal(M.pickMmproj(`${LOCAL}/qwen2.5-coder-7b-instruct-q4_k_m.gguf`, CANDIDATES), null);
    const both = [...CANDIDATES, { path: `${LOCAL}/qwen-3.8-mmproj-Q8_0.gguf`, mtimeMs: 900 }];
    assert.equal(M.pickMmproj(`${LOCAL}/Qwen3.8-27B-UD-Q3_K_XL.gguf`, both), `${LOCAL}/qwen-3.8-mmproj-F16.gguf`);
});

test('no guesses: an mmproj picked as the model, a generic name, nothing given', () => {
    assert.equal(M.pickMmproj(`${LOCAL}/qwen-3.8-mmproj-F16.gguf`, CANDIDATES), null);
    assert.equal(M.pickMmproj(`${LOCAL}/Qwen3.8-27B.gguf`, [{ path: `${LOCAL}/mmproj.gguf` }]), null);
    assert.equal(M.pickMmproj('', CANDIDATES), null);
});

test('helpers', () => {
    assert.equal(M.familyPrefix('Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf'), 'qwen36');
    assert.equal(M.familyPrefix('qwen-3.8-mmproj-F16.gguf'), 'qwen38');
    assert.equal(M.hfRepoRoot(`${HF}/27af/x.gguf`), '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF');
    assert.equal(M.hfRepoRoot(`${LOCAL}/x.gguf`), null);
});
