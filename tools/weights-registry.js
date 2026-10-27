#!/usr/bin/env node
'use strict';
/**
 * Build weights-registry.json (lib/weightsid.js): one entry per model path bench.sqlite has recorded (runs + requests).
 *   exists  -> its content fingerprint (w1:...), the shards' size+mtime it was taken at, and for an HF-cache file the
 *              LFS sha256 its blob is named by.
 *   gone    -> an id only from EVIDENCE below (an HF API lookup, a check written down when the copy was made). A gone
 *              path with no evidence gets NO entry: lib/weightsid.js then reports it unverified and it stays pooled
 *              with its name's reference file (split only on positive evidence of a different file).
 * Read-only on bench.sqlite and on the model files (two 1 MiB reads per file). Usage:
 *   node tools/weights-registry.js [--db <bench.sqlite>] [--out <file>] [--hf]   (--hf: also ask huggingface.co for the
 *   LFS sha256 of every gone HF-cache path, and print what it found; nothing is written for a lookup that fails)
 */
const fs = require('fs');
const path = require('path');
const W = require('../lib/weightsid');

const HF27 = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots';
// Evidence for files that are gone. `sameAs`: another recorded path holding the same bytes; `sha256` (+ `size`): the
// file's own content hash when no copy of it is left.
const EVIDENCE = {
    [`${HF27}/27af057ecb382ddfea5d12837360a8980560e3ed/Qwen3.8-27B-UD-Q6_K_XL.gguf`]: {
        sameAs: `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q6_K_XL.gguf`,
        evidence: 'huggingface.co paths-info (2026-10-15): at revision 27af057 the file is LFS sha256 701d8fa9ed21...a917, 25299061664 bytes -- the blob 4ca720 links to now' },
    [`${HF27}/fe1e2a23d973adb629709749dc4f6756df66ef10/Qwen3.8-27B-UD-Q6_K_XL.gguf`]: {
        sha256: '739202186fd9389bb58497c58b56c8a0d4253d99d20131e6a0427e363e678fc8', size: 25924152384,
        evidence: 'huggingface.co paths-info (2026-10-15): at revision fe1e2a2 the file is LFS sha256 739202186fd9...8fc8, 25924152384 bytes -- a DIFFERENT file from the current 701d8fa9 (25299061664 bytes)' },
    '/home/kyle-4090/llama-lane/models/Qwen3.8-27B-UD/Qwen3.8-27B-UD-Q2_K_XL.gguf': {
        sameAs: `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q2_K_XL.gguf`,
        evidence: 'HANDOFF.md 2026-10-09 23:20: copied to the laptop, "sha256 head fd4730dd8aad0705 matches" (the HF blob name)' },
    '/home/kyle-4090/llama-lane/models/Qwen3.8-27B-UD/Qwen3.8-27B-UD-Q4_K_XL.gguf': {
        sameAs: `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q4_K_XL.gguf`,
        evidence: 'HANDOFF.md 2026-10-12 15:00: rsync of the HF file to the laptop "arrived intact (UD-Q4_K_XL 17.56 GB)" -- size match only' },
};

function args() {
    const a = process.argv.slice(2);
    const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    return { db: get('--db') || path.join(__dirname, '..', '..', 'logs', 'bench.sqlite'), out: get('--out') || path.join(__dirname, '..', 'weights-registry.json'), hf: a.includes('--hf') };
}

/** HF cache path -> the LFS sha256 its blob symlink names, or null. */
function hfBlobSha(p) {
    try {
        const real = fs.realpathSync(p);
        const m = /\/blobs\/([0-9a-f]{64})$/.exec(real);
        return m ? m[1] : null;
    } catch { return null; }
}

/** -> Map path -> rows, from runs and requests. */
function recordedPaths(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const out = new Map();
    try {
        for (const t of ['runs', 'requests']) {
            for (const r of db.prepare(`select model_path p, count(*) n from ${t} where model_path is not null and model_path != '' group by 1`).all()) out.set(r.p, (out.get(r.p) || 0) + r.n);
        }
    } finally { db.close(); }
    return out;
}

async function hfLookup(p) {
    const m = /models--([^/]+)--([^/]+)\/snapshots\/([0-9a-f]{40})\/(.+)$/.exec(p);
    if (!m) return null;
    const url = `https://huggingface.co/api/models/${m[1]}/${m[2]}/paths-info/${m[3]}`;
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `paths=${encodeURIComponent(m[4])}` });
        if (!res.ok) return null;
        const j = await res.json();
        const f = Array.isArray(j) && j[0];
        return f && f.lfs ? { sha256: f.lfs.oid, size: f.lfs.size } : null;
    } catch { return null; }
}

async function build({ db, hf, evidence = EVIDENCE, paths: given }) {
    const rows = given || recordedPaths(db);
    const out = { version: 1, built_at: new Date().toISOString(), note: 'lib/weightsid.js; built by tools/weights-registry.js', paths: {} };
    const bySha = new Map();
    // files on disk first: they are what a gone path's evidence points at
    for (const [p, n] of rows) {
        const sig = W.statSig(p);
        if (!sig) continue;
        const id = W.fingerprintFile(fs.realpathSync(p));
        if (!id) continue;
        const sha = hfBlobSha(p);
        out.paths[p] = { id, exists: true, stat: sig, size: Number(id.split(':')[1]), ...(sha ? { sha256: sha } : {}), rows: n, via: 'file' };
        if (sha) bySha.set(sha, id);
    }
    for (const [p, n] of rows) {
        if (out.paths[p]) continue;
        let ev = evidence[p];
        if (!ev && hf) { const l = await hfLookup(p); if (l) { ev = { ...l, evidence: `huggingface.co paths-info (${new Date().toISOString().slice(0, 10)})` }; console.error(`hf: ${p} -> ${l.sha256} ${l.size}`); } }
        if (!ev) continue;
        let id = null;
        if (ev.sameAs && out.paths[ev.sameAs]) id = out.paths[ev.sameAs].id;
        else if (ev.sha256 && bySha.has(ev.sha256)) id = bySha.get(ev.sha256);
        else if (ev.sha256) id = `sha:${ev.sha256.slice(0, 16)}`;
        if (!id) continue;
        out.paths[p] = { id, exists: false, ...(ev.sha256 ? { sha256: ev.sha256 } : {}), ...(ev.size ? { size: ev.size } : {}), ...(ev.sameAs ? { sameAs: ev.sameAs } : {}), rows: n, via: 'evidence', evidence: ev.evidence };
    }
    return out;
}

if (require.main === module) {
    const a = args();
    build(a).then((reg) => {
        fs.writeFileSync(a.out + '.tmp', JSON.stringify(reg, null, 1) + '\n');
        fs.renameSync(a.out + '.tmp', a.out);
        const vals = Object.values(reg.paths);
        console.log(`${a.out}: ${vals.length} paths (${vals.filter((v) => v.exists).length} on disk, ${vals.filter((v) => !v.exists).length} gone with evidence)`);
    }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { build, EVIDENCE, hfBlobSha };
