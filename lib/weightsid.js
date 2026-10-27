'use strict';
/**
 * WEIGHTS IDENTITY (2026-10-15, Kyle: "Why would a different q blend with this one?" / a different file must not
 * blend). lib/models.js names a local model after its gguf FILE NAME (`local:qwen3.8-27b:q6-k-xl`), so two different
 * files that share a name -- an HF repo that re-uploaded a quant, a local re-conversion -- would pool into one row. The
 * path is no better: an HF repo update moves an unchanged file to a new snapshot dir, and a copy (the laptop's
 * ~/llama-lane/models, the experiment-1/models symlink farm) is the same file under another path.
 *
 * So a file is identified by its CONTENT:
 *   fingerprint  `w1:<total bytes>:<16 hex>` = sha256 over "<total bytes>\n" + the first MiB of the first shard + the
 *                last MiB of the last shard (multi-part ggufs: every `-0000k-of-0000N` shard counts toward the size).
 *                Two reads of 1 MiB, so cheap for a 47 GB pack; the head holds the GGUF header (metadata + tensor
 *                table), so a re-quant or a metadata re-upload changes it. harness/config_identity.py computes the
 *                same value at run time and run.py records it as server.weights (FINGERPRINT_TEST_VECTOR below
 *                pins the two implementations together).
 *   registry     weights-registry.json (tools/weights-registry.js builds it): the fingerprint of every recorded file
 *                that still exists (with its size and mtime, so the dashboard does not re-read it), and, for files
 *                that are GONE, the evidence that maps them to a known file -- an HF API lookup of the snapshot's LFS
 *                sha256, a size/sha-head check noted in HANDOFF.md -- or to an id of their own.
 * Resolution order for one row: the fingerprint the run recorded (server.weights.id) > the registry's entry for the
 * path > a live fingerprint of the file on disk > null ("not verified": pooled with the name's reference file, never
 * split on no evidence).
 *
 * REFERENCE FILE: per catalog name key, the file the plain key belongs to -- the newest file of that name that still
 * exists, else the one with the most rows. Any OTHER verified file of the same name gets `~file:<8 hex>` in its key
 * (models.js withWeightsFile), so it is a row of its own and nothing pools it with the reference.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DASH_DIR = path.join(__dirname, '..');
const DEFAULT_REGISTRY = path.join(DASH_DIR, 'weights-registry.json');
const SAMPLE = 1 << 20;   // 1 MiB from each end
// fingerprint of a fixed 3 MiB file of bytes i % 251, as both implementations must compute it (test/weightsid.test.js,
// harness/test_config_identity.py)
const FINGERPRINT_TEST_VECTOR = 'w1:3145728:b6cae9540ecf650d';

let registryPath = DEFAULT_REGISTRY;
let registryStub;            // tests: an object instead of the file
let registryCache = { sig: null, reg: { paths: {} } };
const liveCache = new Map(); // realpath -> { sig, id }
let references = new Map();  // baseKey -> reference id (prime())

function configure(o) {
    registryPath = (o && o.registry && typeof o.registry === 'string') ? o.registry : DEFAULT_REGISTRY;
    registryStub = o && o.registry && typeof o.registry === 'object' ? o.registry : undefined;
    registryCache = { sig: null, reg: { paths: {} } };
    liveCache.clear();
    references = new Map();
}

function registry() {
    if (registryStub !== undefined) return registryStub;
    let sig = '-';
    try { const st = fs.statSync(registryPath); sig = `${st.mtimeMs}:${st.size}`; } catch { sig = '-'; }
    if (registryCache.sig === sig) return registryCache.reg;
    let reg = { paths: {} };
    try { const j = JSON.parse(fs.readFileSync(registryPath, 'utf-8')); if (j && typeof j === 'object' && j.paths) reg = j; } catch { reg = { paths: {} }; }
    registryCache = { sig, reg };
    return reg;
}

/** The shards of a gguf path, in order ([path] for a single file). */
function shardsOf(p) {
    const m = /^(.*-)(\d{5})-of-(\d{5})(\.gguf)$/.exec(String(p || ''));
    if (!m) return [p];
    const n = Number(m[3]);
    const out = [];
    for (let k = 1; k <= n; k++) out.push(`${m[1]}${String(k).padStart(5, '0')}-of-${m[3]}${m[4]}`);
    return out;
}

/** Content fingerprint of a gguf (all shards), or null when a shard is missing / unreadable. */
function fingerprintFile(p) {
    const parts = shardsOf(p);
    let size = 0;
    const stats = [];
    for (const s of parts) {
        let st; try { st = fs.statSync(s); } catch { return null; }
        if (!st.isFile()) return null;
        stats.push(st); size += st.size;
    }
    const h = crypto.createHash('sha256');
    h.update(`${size}\n`);
    const readAt = (file, pos, len) => {
        const fd = fs.openSync(file, 'r');
        try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); } finally { fs.closeSync(fd); }
    };
    try {
        const first = stats[0], last = stats[stats.length - 1];
        h.update(readAt(parts[0], 0, Math.min(SAMPLE, first.size)));
        const tailLen = Math.min(SAMPLE, last.size);
        h.update(readAt(parts[parts.length - 1], last.size - tailLen, tailLen));
    } catch { return null; }
    return `w1:${size}:${h.digest('hex').slice(0, 16)}`;
}

/** Signature of a path's shards as they are now (size + mtime), or null when one is missing. */
function statSig(p) {
    const parts = shardsOf(p);
    const bits = [];
    for (const s of parts) {
        let st; try { st = fs.statSync(s); } catch { return null; }
        bits.push(`${st.size}:${Math.round(st.mtimeMs)}`);
    }
    return bits.join('|');
}

/** A live fingerprint, cached by real path and stat. */
function liveId(p) {
    let real; try { real = fs.realpathSync(p); } catch { return null; }
    const sig = statSig(real);
    if (!sig) return null;
    const hit = liveCache.get(real);
    if (hit && hit.sig === sig) return hit.id;
    const id = fingerprintFile(real);
    liveCache.set(real, { sig, id });
    return id;
}

/**
 * The weights id of a recorded model path. `recorded`: the run's own server.weights ({id}) when it has one.
 * -> { id, via: 'recorded' | 'registry' | 'file' | null, exists }
 */
function weightsIdOf(modelPath, recorded) {
    const p = String(modelPath || '');
    if (recorded && typeof recorded === 'object' && typeof recorded.id === 'string' && recorded.id) return { id: recorded.id, via: 'recorded', exists: null };
    if (!p) return { id: null, via: null, exists: false };
    const e = registry().paths[p];
    const sig = statSig(p);
    if (e && e.id) {
        // a registry entry for a file that still exists holds while the file is unchanged; a changed file is re-read
        if (!sig || !e.stat || e.stat === sig) return { id: e.id, via: 'registry', exists: !!sig };
    }
    if (sig) { const id = liveId(p); if (id) return { id, via: 'file', exists: true }; }
    return { id: null, via: null, exists: false };
}

/**
 * The reference file per name key, from every recorded path of that name: `observed` is [{baseKey, path, rows}].
 * Reference = the id of the newest existing file of the name; when none exists, the id with the most rows.
 */
function prime(observed) {
    const by = new Map();
    for (const o of observed || []) {
        if (!o || !o.baseKey || !o.path) continue;
        const w = weightsIdOf(o.path, o.recorded);
        if (!w.id) continue;
        if (!by.has(o.baseKey)) by.set(o.baseKey, new Map());
        const ids = by.get(o.baseKey);
        const x = ids.get(w.id) || { rows: 0, mtime: -1 };
        x.rows += o.rows || 1;
        if (w.exists) { let mt = -1; try { mt = fs.statSync(o.path).mtimeMs; } catch { mt = -1; } x.mtime = Math.max(x.mtime, mt); }
        ids.set(w.id, x);
    }
    const out = new Map();
    for (const [k, ids] of by) {
        const list = [...ids.entries()];
        const live = list.filter(([, x]) => x.mtime >= 0).sort((a, b) => b[1].mtime - a[1].mtime);
        const pick = live.length ? live[0] : list.sort((a, b) => b[1].rows - a[1].rows || (a[0] < b[0] ? -1 : 1))[0];
        out.set(k, pick[0]);
    }
    references = out;
    return out;
}
function referenceId(baseKey) { return references.get(baseKey) || null; }

/** `w1:25299061664:701d8fa9...` / `sha:<hex>` -> 8 hex for a key or label. */
function shortId(id) {
    const s = String(id || '');
    const m = /([0-9a-f]{8,})$/i.exec(s);
    return m ? m[1].slice(0, 8).toLowerCase() : s.replace(/[^\w]+/g, '').slice(-8);
}

module.exports = { configure, registry, shardsOf, fingerprintFile, weightsIdOf, prime, referenceId, shortId, statSig, FINGERPRINT_TEST_VECTOR };
