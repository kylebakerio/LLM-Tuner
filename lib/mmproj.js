'use strict';
// --- MMPROJ DISCOVERY ---
// Finds the multimodal projector (mmproj*.gguf) that goes with a model file, so
// the UI can fill the mmproj path in. Pure: server4.js lists the candidate
// files. Tested in test/mmproj.test.js.
const path = require('path');

function isMmproj(file) {
    return /mmproj/i.test(path.basename(String(file))) && /\.gguf$/i.test(String(file));
}

// HF cache layout: <cache>/models--<org>--<repo>/snapshots/<revision>/<file>.
// Each revision only holds the files it references, so a repo's mmproj is
// often in a different snapshot than the weights.
function hfRepoRoot(modelPath) {
    const m = String(modelPath).match(/^(.*\/models--[^/]+)\/snapshots\/[^/]+\/[^/]+$/);
    return m ? m[1] : null;
}

// "Qwen3.8-27B-UD-Q6_K_XL.gguf" -> "qwen38": the first name+version run,
// lowercased with separators dropped, so "qwen-3.8-mmproj-F16.gguf" matches.
function familyPrefix(fileName) {
    const m = String(fileName).match(/[A-Za-z]+[-_ ]?\d+(?:\.\d+)?/);
    return m ? m[0].toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

function squash(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The projector for `modelPath` among `candidates` ([{ path, mtimeMs }]), or null:
// - HF cache model: any mmproj in the same repo (any snapshot), preferring the
//   model's own snapshot, then F16, then the newest.
// - Plain directory: an mmproj in the same directory whose name starts with the
//   model's family prefix; ties go to F16, then the newest. A generic
//   "mmproj.gguf" in a shared folder isn't guessed at.
function pickMmproj(modelPath, candidates) {
    const model = String(modelPath || '');
    if (!model || isMmproj(model)) return null;
    const list = (candidates || []).filter((c) => c && isMmproj(c.path) && c.path !== model);
    const repo = hfRepoRoot(model);
    const dir = path.dirname(model);
    let pool;
    if (repo) {
        pool = list.filter((c) => c.path.startsWith(repo + '/snapshots/'));
    } else {
        const family = familyPrefix(path.basename(model));
        pool = family ? list.filter((c) => path.dirname(c.path) === dir && squash(path.basename(c.path)).startsWith(family)) : [];
    }
    if (pool.length === 0) return null;
    const rank = (c) => [path.dirname(c.path) === dir ? 1 : 0, /f16/i.test(path.basename(c.path)) ? 1 : 0, c.mtimeMs || 0];
    pool.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        return (rb[0] - ra[0]) || (rb[1] - ra[1]) || (rb[2] - ra[2]);
    });
    return pool[0].path;
}

module.exports = { isMmproj, hfRepoRoot, familyPrefix, pickMmproj };
