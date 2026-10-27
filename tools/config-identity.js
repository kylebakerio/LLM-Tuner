#!/usr/bin/env node
'use strict';
/**
 * The dashboard's config identity (lib/configid.js) for callers outside this process: tools/queue_runner.py,
 * harness/run.py (via harness/config_identity.py), sweeps/idle-guard.py, tools/tier-list.py. Read-only everywhere.
 *
 *   node tools/config-identity.js check  < {"spec": {...}, "tasks": [..], "self_item": id, "self_started": iso}
 *        -> {"identity": {...} | null, "scored": {task: [{status, dir}]}, "claimed": {task: {item, label}},
 *            "unfinished": {task: [{dir, result, session, rebuildable}]}}
 *        unfinished (2026-10-19): rows whose question is not answered yet -- not in `scored`. session "saved" (and
 *        rebuildable not false): it waits for a CONTINUATION, no fresh run; "pruned" / rebuildable false: a fresh run is
 *        allowed; null: unknown (lib/configid.js awaitsContinuation reads it as waiting).
 *        spec: lib/configid.js specRun (dir, config = run.py's battery config, server | launch, env)
 *   node tools/config-identity.js batteries
 *        -> {"batteries": {dir: [{key, modelKey, rowKey, display}]}}   every scored battery's cell(s)
 *   node tools/config-identity.js identity < {"spec": {...}}  -> {"identity": ...}
 * Exit 0 with {"error": "..."} on a failure the caller should treat as "unknown" (it then skips nothing).
 */
const path = require('path');

function readStdin() {
    return new Promise((resolve) => {
        let s = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (d) => { s += d; });
        process.stdin.on('end', () => resolve(s));
        if (process.stdin.isTTY) resolve('');
    });
}

/** The answer to one command (`input`: the parsed stdin). Exported for the tests; the CLI below reads stdin and prints it. */
function answer(cmd, input = {}) {
    const ID = require('../lib/configid');
    if (cmd === 'batteries') {
        const idx = ID.scoredIndex();
        const out = {};
        for (const [dir, keys] of idx.byDir) out[dir] = [...keys].map((k) => ({ key: k, ...idx.display.get(k) }));
        return { batteries: out };
    }
    if (cmd === 'identity') {
        ID.scoredIndex();                       // primes the weights references the identity depends on
        return { identity: ID.identityOfSpec(input.spec) };
    }
    if (cmd === 'check') {
        const tasks = Array.isArray(input.tasks) ? input.tasks.map(String) : null;
        const index = ID.scoredIndex();
        const identity = ID.identityOfSpec(input.spec);
        if (!identity) return { identity: null, scored: {}, claimed: {}, unfinished: {}, why: 'the config cannot be identified (no model file / unresolved model)' };
        const scored = ID.scoredFor(identity, tasks, index);
        const unfinished = ID.unfinishedFor(identity, tasks, index);
        let claimed = {};
        try {
            const Database = require('better-sqlite3');
            const db = new Database(require('../lib/db').DB_PATH, { readonly: true, fileMustExist: true });
            try { claimed = ID.claimedFor(identity, tasks, { db, selfItem: input.self_item ?? null, selfStarted: input.self_started || null }); } finally { db.close(); }
        } catch (e) { claimed = {}; }
        for (const t of Object.keys(scored)) delete claimed[t];
        return { identity, scored, claimed, unfinished };
    }
    throw new Error(`usage: ${path.basename(process.argv[1] || 'config-identity.js')} check|identity|batteries`);
}

async function main() {
    const cmd = process.argv[2];
    const input = cmd === 'batteries' ? {} : JSON.parse((await readStdin()) || '{}');
    return answer(cmd, input);
}

if (require.main === module) {
    main().then((o) => { process.stdout.write(JSON.stringify(o) + '\n'); })
        .catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }) + '\n'); });
}
module.exports = { answer };
