// What the public site (public/server.js, lab.kylebaker.io; ai.kylebaker.io until 2026-10-22) may show, and nothing more (2026-10-02).
//
// The Models catalog is built for the private dashboard. It carries things that must never leave this
// machine: each codebench task's story / probes / "weak model failure" text (the task CONTENT -- publishing
// it would contaminate the private corpus, and several describe production incidents in other apps),
// filesystem paths in launch commands and source lists, and RPC worker addresses. Kyle's rule: task NAMES
// may be public, task content may not.
//
// Two layers, so a field added to the catalog later fails closed on the dangerous axis:
//   1. structure: whole keys dropped wherever they appear (DROP_KEYS), and taskMeta reduced to a whitelist;
//   2. every remaining string scrubbed: absolute paths cut to their last segment, IPv4 addresses and
//      private hostnames masked.
// The scrub is deterministic, so identifiers that embed the same path (a config's `key` JSON and its
// facets) still match each other after it.
// test/publicdata.test.js serializes the output and asserts none of the forbidden material survives.

// Keys removed wherever they occur.
const DROP_KEYS = new Set([
    'story', 'probes', 'weak_model_failure', 'incident_date',   // task content / incident details
    'sources',                                                   // file lists: paths to logs, results, configs
    'prompt', 'prompts', 'transcript', 'transcript_tail', 'patch', 'diff', 'stderrTail', 'stdout', 'stderr',
    'env', 'environment', 'token', 'password', 'ssh',
    'user_note',                                                 // Kyle's own note on a queue item (queue_meta): never public
    // RUNS THAT ASKED (2026-10-19): the questions a run ended on and a reviewer's notes on them quote or paraphrase the task
    // (task content). The public site gets the counts beside them (`answered`: passed / failed / compacted; `unfinished`:
    // n / compacted / saved / pruned) and shows a category note; the text stays here.
    'askedAnswerable',      // a reviewer's (AI) note that the prompt answers the question (lib/annotations.js)
    'answeredNotes',        // a cell's runs answered with the original prompt: what each had asked, what it replaced
    'unfinishedNotes',      // a cell's runs still waiting for the answer: the question, the session, the AI note
    'unfinishedRuns',       // the model page's list of them
]);
// taskMeta: only these survive.
// bonus/parent/label: a `<id>+bonus` task's names only (its bonus_note is task content and stays out). skills: the report
// card's tags per task -- public (Kyle 2026-10-14: "it is fine to talk generally about the skills, as that's not a
// gameable target"), like the task names they hang on; the tag definitions (catalog.skillTags) pass through as well.
// diagnostic: a functional-check task (category `diagnostic`, 2026-10-17), out of every score -- the flag is public like the category.
// level/base: a prompt-level problem's (`T@L3`, 2026-10-17) level and its task's name -- names, like the ids; scoredConfigs /
// unscored: how many config rows scored it, and whether that is below the minimum for points (LEVEL_MIN_CONFIGS).
const TASK_META_KEEP = ['repo', 'variant', 'tier', 'category', 'diagnostic', 'sample_group', 'timeout_s', 'bonus', 'parent', 'label', 'skills', 'level', 'base', 'scoredConfigs', 'unscored'];

// Machine names that identify the rig's network rather than describing the work.
const HOST_RE = /\b(pop-os|localhost)\b/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
// A dotted quad that is a VERSION, not an address (2026-10-20: "Strata 0.1.44.1" became "Strata <ip>"): one that starts
// with 0 (no host address does; 0.0.0.0, the bind-all address, is still masked) or follows a 'v' / 'version '.
function maskIpv4(s) {
    return s.replace(IPV4_RE, (m, off, str) => {
        const addr = m.replace(/:\d+$/, '');
        if (/^0\./.test(addr) && addr !== '0.0.0.0') return m;
        if (/(?:\bv|\bversion\s)$/i.test(str.slice(Math.max(0, off - 8), off))) return m;
        return '<ip>';
    });
}
const IPV6_RE = /\[?\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b\]?(?::\d+)?/gi;
// An absolute (or ~) path of 2+ segments -> its last segment. Runs inside larger strings (launch commands).
const PATH_RE = /(?:~|(?<![\w.-]))\/(?:[\w.@+=,-]+\/)+([\w.@+=,-]+)/g;

function scrubString(s) {
    if (typeof s !== 'string' || !s) return s;
    return maskIpv4(s.replace(PATH_RE, '$1'))
        .replace(IPV6_RE, (m) => (/:/.test(m) && /[a-f]/i.test(m) ? '<ip>' : m))
        .replace(HOST_RE, 'host')
        .replace(/\/home\/[\w.-]+/g, '~');   // belt and braces: a bare home dir with no further segment
}

function sanitize(value, key) {
    if (Array.isArray(value)) return value.map((v) => sanitize(v));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (DROP_KEYS.has(k)) continue;
            const sk = scrubString(k);          // object keys too (task ids are fine, but a key could be a path)
            out[sk] = sanitize(v, k);
        }
        return out;
    }
    return typeof value === 'string' ? scrubString(value) : value;
}

/** The private catalog (lib/models.js listModels + disk sizes) -> what the public site serves. */
function sanitizeCatalog(cat) {
    if (!cat || typeof cat !== 'object') return cat;
    const meta = {};
    for (const [id, m] of Object.entries(cat.taskMeta || {})) {
        const keep = {};
        for (const k of TASK_META_KEEP) if (m && m[k] !== undefined) keep[k] = m[k];
        meta[id] = keep;
    }
    const out = sanitize({ ...cat, taskMeta: undefined, sources: undefined });
    delete out.taskMeta; delete out.sources;
    out.taskMeta = sanitize(meta);
    return out;
}

/** Any other payload (a model's detail record, the running list): structure drop + string scrub. */
function sanitizePayload(x) { return sanitize(x); }

// ------------------------------------------------------------------ "what's running now" (2026-10-07)
// Kyle: "the 'what's running now' should include the 'question' that queue item answers, and how many passes/fails
// it is currently at." Two pure steps, so the whitelist is testable without a server:
//   liveItem()    -- dashboard side (server4.js writes logs/public-live.json): the running queue item + the statuses
//                    of its finished tasks -> the ONLY queue fields that may leave the dashboard;
//   liveRunning() -- public side (public/server.js /api/live): one running battery, field by field.
// The queue row also carries Kyle's note (queue_meta.user_note), the item's own notes, its launch command, env and
// result paths. None of those is copied here, by construction: nothing is spread, every field is named.

/** Result statuses of the tasks that have finished -> { passed, failed, excluded, remaining, total }.
 *  `sets`: { solved, excluded } (lib/codebench.js SOLVED / EXCLUDED). An excluded status (PROVIDER_ERROR, ABORTED,
 *  HARNESS_ERROR ...) is not a model answer: counted on its own, never as a fail. A status that is not readable yet
 *  (the result file is mid-write) stays in `remaining`. */
function liveTally(statuses, total, sets = {}) {
    const solved = sets.solved || new Set(['pass', 'pass*']);
    const excludedSet = sets.excluded || new Set();
    let passed = 0, failed = 0, excluded = 0;
    for (const st of statuses || []) {
        if (typeof st !== 'string' || !st) continue;
        if (solved.has(st)) passed++; else if (excludedSet.has(st)) excluded++; else failed++;
    }
    const n = Math.max(Number(total) || 0, passed + failed + excluded);
    return { passed, failed, excluded, remaining: n - passed - failed - excluded, total: n };
}

const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);

/** What the public site may know about the queue item running a battery: its question and the tally. `item` is
 *  lib/queue.js runningFor() (or null: a battery no queue item started); `tally` is liveTally(). */
function liveItem(item, tally) {
    const out = {};
    const q = item && typeof item.question === 'string' ? item.question.replace(/\s+/g, ' ').trim() : '';
    if (q) out.question = q;
    if (tally) for (const k of ['passed', 'failed', 'excluded', 'remaining', 'total']) out[k] = count(tally[k]);
    return out;
}

/** One running battery as /api/live serves it. `r`: its entry in the dashboard's snapshot; `extra`: that snapshot's
 *  items[dir] (liveItem(), absent from an older dashboard); `model`: its display name from the public catalog. */
function liveRunning(r, extra, model) {
    r = r || {};
    const out = { dir: r.dir, runner: r.runner || null, state: r.state, lane: r.lane, task: r.task || null,
        tasks: count(r.tasks), done: count(r.done), solved: count(r.solved), model: model || null };
    const x = extra && typeof extra === 'object' ? extra : null;
    if (x && typeof x.question === 'string' && x.question.trim()) out.question = x.question.trim();
    if (x && x.passed != null && x.failed != null) for (const k of ['passed', 'failed', 'excluded', 'remaining']) out[k] = count(x[k]);
    return out;
}

module.exports = { sanitizeCatalog, sanitizePayload, scrubString, DROP_KEYS, TASK_META_KEEP, liveTally, liveItem, liveRunning };
