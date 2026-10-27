'use strict';
// --- GGUF MODEL SCAN ---
// Lists the launchable gguf files for GET /api/models (the launch panel's model select, the model
// picker, the bench dropdowns, lib/sweep.js and dash-cli all read that list). Tested in
// test/modelscan.test.js.
//
// Roots are walked in order, recursively (symlinked directories too), and the FIRST path a file is
// reached by wins. Order matters: ROOT/models holds symlinks into /data/models, and saved launch
// profiles store those symlink paths as modelPath (applyConfigToUI matches it against the option
// values by string equality), so a /data/models path to the same file must not replace them. The
// other paths a file was reached by are kept in `aliases`.
//
// A multi-part gguf (`X-00001-of-00003.gguf`) is listed once, as part 1: llama.cpp is given the
// first part and opens the rest from the same directory. Its `name` drops the split suffix and its
// `size`/`bytes` are the sum of every part (part 1 is an ~11 MB header, not the model).
const fsp = require('fs').promises;
const path = require('path');
const ModelName = require('../ui/shared/modelname.js'); // the one display-name helper (browser + node)

const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
const MAX_DEPTH = 8; // HF hub: <root>/models--org--repo/snapshots/<rev>/<file> is depth 3

/** A split part other than the first ("-00002-of-00003.gguf"): not loadable on its own. */
function isHiddenSplitPart(name) {
    const m = /-(\d+)-of-\d+\.gguf$/i.exec(String(name));
    return m ? parseInt(m[1], 10) > 1 : false;
}

/** {part, total} for a split gguf name or path, else null. */
function splitInfo(name) {
    const m = SPLIT_RE.exec(String(name));
    return m ? { part: Number(m[1]), total: Number(m[2]) } : null;
}

/** "X-UD-Q2_K_XL-00001-of-00003.gguf" -> "X-UD-Q2_K_XL.gguf"; other names unchanged. */
function displayName(name) {
    return ModelName.stripSplit(name);
}

/** Every part's path for a part-1 path (only that path for a single-file gguf). */
function partPaths(p) {
    const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(String(p));
    if (!m) return [p];
    const n = Number(m[3]);
    const out = [];
    for (let i = 1; i <= n; i++) out.push(`${m[1]}-${String(i).padStart(5, '0')}-of-${m[3]}.gguf`);
    return out;
}

/**
 * Bytes of the whole model at `p` (a part-1 path sums every part, next to that path -- where
 * llama.cpp looks for them). -> {bytes, parts, missing}; a missing part under-counts and is
 * reported in `missing` rather than failing the entry. bytes null when nothing could be stat'ed.
 */
async function modelBytes(p, fs = fsp) {
    const parts = partPaths(p);
    let bytes = 0, found = 0;
    const missing = [];
    for (const q of parts) {
        try { bytes += (await fs.stat(q)).size; found++; } catch { missing.push(path.basename(q)); }
    }
    return { bytes: found ? bytes : null, parts: parts.length, missing };
}

const toGb = (bytes) => ((bytes || 0) / (1024 * 1024 * 1024)).toFixed(2);

/**
 * roots: [{dir, source}] in priority order (source: 'local' | 'huggingface' | ...).
 * -> [{name, file, path, realPath, aliases, size (GB string), bytes, parts, missingParts?, source}]
 *
 * Dedup: first by realpath (one file reached as a symlink and as itself), then by (file name,
 * total bytes) -- a byte-for-byte copy of a model on another drive is the same model, and listing
 * both would only make the picker show it twice.
 */
async function scanModelDirs(roots, { fs = fsp, maxDepth = MAX_DEPTH } = {}) {
    const found = [];
    const visitedDirs = new Set();
    async function walk(dir, source, depth) {
        let real;
        try { real = await fs.realpath(dir); } catch { return; }
        if (visitedDirs.has(real) || depth > maxDepth) return; // symlink loops, and a root nested in another
        visitedDirs.add(real);
        let items;
        try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const item of items) {
            const full = path.join(dir, item.name);
            let isDir = item.isDirectory(), isFile = item.isFile();
            if (item.isSymbolicLink()) {
                try { const st = await fs.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); }
                catch { continue; } // dangling link (an unmounted drive)
            }
            if (isDir) {
                // dot-dirs: HF's .locks / .no_exist, ROOT/models/.cache (download metadata only)
                if (!item.name.startsWith('.')) await walk(full, source, depth + 1);
            } else if (isFile && /\.gguf$/i.test(item.name) && !isHiddenSplitPart(item.name)) {
                found.push({ path: full, file: item.name, source });
            }
        }
    }
    for (const r of roots || []) {
        if (r && r.dir) await walk(r.dir, r.source || 'local', 0);
    }

    const out = [];
    const byReal = new Map(), byContent = new Map();
    for (const f of found) {
        let realPath;
        try { realPath = await fs.realpath(f.path); } catch { continue; }
        // mmproj files are not deduped: lib/mmproj.js pairs a model with the projector in its own
        // HF snapshot, and every snapshot's mmproj-F16.gguf is a link to one shared blob.
        const dedupe = !/mmproj/i.test(f.file);
        const seen = dedupe && byReal.get(realPath);
        if (seen) { if (seen.path !== f.path) seen.aliases.push(f.path); continue; }
        const { bytes, parts, missing } = await modelBytes(f.path, fs);
        if (bytes == null) { console.warn(`Skipping model ${f.path}: cannot stat`); continue; }
        const contentKey = `${f.file}\0${bytes}`;
        const copy = dedupe && byContent.get(contentKey);
        if (copy) { copy.aliases.push(f.path); byReal.set(realPath, copy); continue; }
        const entry = {
            name: displayName(f.file), file: f.file, path: f.path, realPath, aliases: [],
            size: toGb(bytes), bytes, parts, source: f.source,
            // 'model' | 'mmproj' | 'draft' | 'other': the launch lists show only 'model'; the rest
            // stay in the response for the mmproj auto-fill and the draft-model / mmproj fields
            kind: ModelName.modelFileKind(f.file, bytes),
        };
        if (missing.length) entry.missingParts = missing;
        if (dedupe) { byReal.set(realPath, entry); byContent.set(contentKey, entry); }
        out.push(entry);
    }
    return out;
}

module.exports = { isHiddenSplitPart, splitInfo, displayName, partPaths, modelBytes, scanModelDirs, MAX_DEPTH };

/**
 * The catalog's `diskBytes` (lib/models.js) comes from a model_path its runs recorded; runs that
 * predate recording one (and llama-bench-only models) leave it null although the file is on disk,
 * which drops the model from the Models page's GB-per-solve chart. Fill those from the scan.
 * keyOf(path) -> catalog key (lib/models.js canonicalModel(path).key). Returns a new catalog
 * object; the one passed in (listModels may cache it) is not modified. Existing values are kept.
 */
function fillDiskBytes(catalog, scanned, keyOf) {
    if (!catalog || !Array.isArray(catalog.models)) return catalog;
    const bytesOf = new Map();
    for (const m of scanned || []) {
        if (m.bytes == null || /mmproj/i.test(m.file || m.name || '')) continue;
        let key;
        try { key = keyOf(m.path); } catch { continue; }
        if (key && !bytesOf.has(key)) bytesOf.set(key, m.bytes);
    }
    let changed = false;
    const models = catalog.models.map((m) => {
        if (m.provider !== 'local' || m.diskBytes != null || !bytesOf.has(m.key)) return m;
        changed = true;
        return { ...m, diskBytes: bytesOf.get(m.key) };
    });
    return changed ? { ...catalog, models } : catalog;
}

module.exports.fillDiskBytes = fillDiskBytes;
