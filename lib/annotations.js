'use strict';
// --- RUN ANNOTATIONS (2026-10-19, Kyle) -- read-only, display only ---
// A run annotation is a judgement about ONE result file that the harness did not record: a reviewer (a person or an
// agent) read the transcript and wrote it down. They live in <codebench root>/annotations/*.json, next to results/,
// and this module only ever reads them.
//
// Kinds read:
//  - "unfinished" (see UNFINISHED_KIND below): the run's session ended asking the user a question that was never
//    answered with the original prompt. lib/codebench.js / lib/models.js keep such rows out of every tally.
//  - "asked-answerable": a reviewer's (AI) note that the question it ended on is answered by the task prompt. Shown only
//    as an extra note on an unfinished run's cell, in the lab. Schema v1:
//   { v: 1, kind: "asked-answerable", created: "2026-10-19", method: "...",
//     runs: { "<battery dir>/<result file name without .json>": {
//         battery, task, runner, status, answerable: "yes" | "partly" | "no", asked, where, note, compactions } } }
// Only answerable "yes" and "partly" are kept. Every *.json of that kind in the directory is read (sorted by name, a
// later file wins for the same run), so a second review can land beside the first without code changes.
//
// The directory: $CODEBENCH_ANNOTATIONS_DIR, else <root>/annotations. A missing or unreadable directory, a file that is
// not JSON, another kind or version, a run that is not an object: all read as "no annotation", never as an error.
const fs = require('fs');
const path = require('path');

const KIND = 'asked-answerable';
const KEEP = new Set(['yes', 'partly']);
const TTL_MS = 10000;

function annotationsDir(root) {
    if (process.env.CODEBENCH_ANNOTATIONS_DIR) return process.env.CODEBENCH_ANNOTATIONS_DIR;
    return root ? path.join(root, 'annotations') : null;
}

/** mtime:size of every *.json in the directory (and the directory's own mtime), '-' when there is none. Cheap: stats
 *  only. lib/models.js inputSignature carries it, so a file that lands (or changes) rebuilds the catalog. */
function signature(root) {
    const dir = annotationsDir(root);
    if (!dir) return '-';
    let sig = '-';
    try {
        const st = fs.statSync(dir);
        if (st.isDirectory()) {
            const parts = [String(st.mtimeMs)];
            for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
                try { const s = fs.statSync(path.join(dir, f)); parts.push(`${f}:${s.mtimeMs}:${s.size}`); } catch { /* gone */ }
            }
            sig = parts.join(',');
        }
    } catch { sig = '-'; }
    // the catalog build that follows this check must read the files it saw change, not the TTL's copy
    if (cache.dir === dir && cache.sig !== sig) cache.at = 0;
    return sig;
}

const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** One run's record -> { answerable, note } or null. The note is the file's own; without one it is built from
 *  `asked` / `where` in the same words. */
function entryOf(r) {
    if (!r || typeof r !== 'object') return null;
    const answerable = typeof r.answerable === 'string' ? r.answerable.trim().toLowerCase() : null;
    if (!KEEP.has(answerable)) return null;
    let note = typeof r.note === 'string' && r.note.trim() ? r.note : null;
    if (!note) {
        const asked = typeof r.asked === 'string' && r.asked.trim() ? `ended asking "${r.asked.trim()}"` : 'ended asking the user a question';
        const where = typeof r.where === 'string' && r.where.trim() ? `; the prompt answers this: ${r.where.trim()}` : '; the task prompt already answers it';
        note = asked + where;
    }
    return { answerable, note: clip(note, 600) };
}

// KIND "unfinished" (2026-10-19, Kyle): the index of PAST runs whose session ended asking the user something (harness
// early_stop resend-v2, ending "question") and whose question was never answered with the original prompt -- written by
// codebench tools/unfinished-index.py. Schema v1: { v: 1, kind: "unfinished", created, rule, runs: { "<battery>/<result
// basename>": { battery, task, runner, status, question, compactions, wall_s, cap_s, session: "saved" | "pruned",
// rebuildable: true | false | null, ... } } }. New runs carry the same fact in their own result (run.unfinished).
const UNFINISHED_KIND = 'unfinished';
function unfinishedEntryOf(r) {
    if (!r || typeof r !== 'object') return null;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
        question: typeof r.question === 'string' && r.question.trim() ? clip(r.question, 600) : null,
        compactions: n(r.compactions),
        session: r.session === 'saved' || r.session === 'pruned' ? r.session : null,
        rebuildable: typeof r.rebuildable === 'boolean' ? r.rebuildable : null,
    };
}

function readAll(dir) {
    const map = new Map(), unfinished = new Map();
    let files = [];
    try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return { map, unfinished }; }
    for (const f of files) {
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
        if (!d || typeof d !== 'object' || d.v !== 1 || !d.runs || typeof d.runs !== 'object') continue;
        if (d.kind !== KIND && d.kind !== UNFINISHED_KIND) continue;
        for (const [key, r] of Object.entries(d.runs)) {
            if (typeof key !== 'string' || !key.includes('/')) continue;
            const k = key.replace(/\.json$/, '');
            if (d.kind === UNFINISHED_KIND) { const e = unfinishedEntryOf(r); if (e) unfinished.set(k, e); continue; }
            const e = entryOf(r);
            if (e) map.set(k, e); else map.delete(k);   // a later "no" overrides
        }
    }
    return { map, unfinished };
}

let cache = { dir: null, sig: null, at: 0, map: new Map(), unfinished: new Map() };
/** "<battery>/<file without .json>" -> { answerable, note } for every asked-answerable run (yes / partly). */
function loaded(root) {
    const dir = annotationsDir(root);
    if (!dir) return { map: new Map(), unfinished: new Map() };
    const now = Date.now();
    if (cache.dir === dir && now - cache.at < TTL_MS) return cache;
    const sig = signature(root);
    if (cache.dir !== dir || cache.sig !== sig) cache = { dir, sig, at: now, ...(sig === '-' ? { map: new Map(), unfinished: new Map() } : readAll(dir)) };
    else cache.at = now;
    return cache;
}
function askedAnswerableMap(root) { return loaded(root).map; }
/** "<battery>/<file without .json>" -> { question, compactions, session, rebuildable } for every indexed unfinished run. */
function unfinishedMap(root) { return loaded(root).unfinished; }
function unfinishedIndexOf(root, dir, file) {
    if (!dir || !file) return null;
    try { return unfinishedMap(root).get(`${dir}/${String(file).replace(/\.json$/, '')}`) || null; } catch { return null; }
}

/** The mark for one result file of a battery, or null. `file` may carry its .json. */
function askedAnswerableOf(root, dir, file) {
    if (!dir || !file) return null;
    try { return askedAnswerableMap(root).get(`${dir}/${String(file).replace(/\.json$/, '')}`) || null; } catch { return null; }
}

function _resetForTests() { cache = { dir: null, sig: null, at: 0, map: new Map(), unfinished: new Map() }; }

module.exports = { annotationsDir, signature, askedAnswerableMap, askedAnswerableOf, unfinishedMap, unfinishedIndexOf, KIND, UNFINISHED_KIND, _resetForTests };
