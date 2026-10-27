'use strict';
// History's merged CSV + bench.sqlite stream (lib/history.js + the DB-only queries in lib/db.js),
// 2026-09-30, Kyle: codebench-queue requests reach only bench.sqlite, so /api/logs/recent pages
// over both sources by completion time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeNewestFirst, dbRowToRecentRow } = require('../lib/history');

// Newest-first keys, as the server builds them.
const keys = (ts, extra) => ts.map((t, i) => ({ t, ...extra(i) }));

test('merge pages newest-first across both sources and returns each page oldest-first', () => {
    const csv = keys([90, 70, 50, 10], (i) => ({ line: `c${i}` }));
    const db = keys([100, 80, 60, 40, 20], (i) => ({ id: i }));
    // merged newest-first: 100d 90c 80d 70c 60d 50c 40d 20d 10c
    const p0 = mergeNewestFirst(csv, db, 0, 3);
    assert.deepEqual(p0.map((e) => e.t), [80, 90, 100]);
    assert.deepEqual(p0.map((e) => e.from), ['db', 'csv', 'db']);
    // An offset that straddles both sources
    assert.deepEqual(mergeNewestFirst(csv, db, 3, 3).map((e) => e.t), [50, 60, 70]);
    // The tail: fewer than `limit` left, then nothing
    assert.deepEqual(mergeNewestFirst(csv, db, 7, 3).map((e) => e.t), [10, 20]);
    assert.deepEqual(mergeNewestFirst(csv, db, 9, 3), []);
});

test('merge works with either source empty and keeps NaN timestamps last', () => {
    assert.deepEqual(mergeNewestFirst([], keys([3, 2, 1], (i) => ({ id: i })), 0, 2).map((e) => e.t), [2, 3]);
    assert.deepEqual(mergeNewestFirst(keys([3, 2], () => ({})), [], 1, 5).map((e) => e.t), [2]);
    const m = mergeNewestFirst(keys([NaN], () => ({})), keys([5], () => ({})), 0, 2);
    assert.deepEqual(m.map((e) => e.from), ['csv', 'db']);   // oldest-first: the NaN row sorts as oldest
});

test('a DB row maps to the /api/logs/recent row shape', () => {
    const r = dbRowToRecentRow({
        id: 7, source: 'llama-log-import', csv_run_id: 'log:queue/84-flashnext-leg:6170', completed_at: '2026-10-01T05:07:10Z',
        model_path: '/m/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf', launch_command: '/b/llama-server -m x', n_ctx: 131072,
        prompt_tokens: 64, gen_tokens: 260, reasoning_tokens: null, prefill_tps: 37.3, gen_tps: 11.96, prompt_latency_s: 1.7,
        wall_s: 23.37, draft_accept_rate: 0.53571, draft_accepted: 135, draft_generated: 252, draft_mean_len: null, aborted: 0,
        telemetry_json: JSON.stringify({ masterGpuTemp: 61, gpuMem: 20000 }), devices_json: null, config_json: '{"ctx":131072}',
    });
    assert.equal(r.timestamp, '2026-10-01T05:07:10Z');
    assert.equal(r.runId, 'log:queue/84-flashnext-leg:6170');
    assert.equal(r.model, 'Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf');
    assert.equal(r.genTps, 11.96);
    assert.equal(r.draftAcceptRate, 0.53571);
    assert.equal(r.draftAccepted, 135);
    assert.equal(r.aborted, false);
    assert.equal(r.detail.launchCommand, '/b/llama-server -m x');
    assert.equal(r.detail.launchLog, 'log:queue/84-flashnext-leg');
    assert.equal(r.detail.gpuTemp, 61);
    assert.equal(r.detail.vram, 20000);
    assert.equal(r.detail.loadTime, null);
    assert.deepEqual(r.detail.config, { ctx: 131072 });
});

test('DB-only queries skip rows that duplicate the CSV and page newest-first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lldash-history-'));
    const dbPath = path.join(dir, 'bench.sqlite');
    const prev = process.env.BENCH_DB;
    process.env.BENCH_DB = dbPath;
    delete require.cache[require.resolve('../lib/db')];
    try {
        const db = require('../lib/db');
        const d = db.open();
        assert.ok(d, 'temp bench.sqlite opens');
        const ins = d.prepare('INSERT INTO requests (source, csv_run_id, completed_at, model_path) VALUES (?,?,?,?)');
        ins.run('csv-import', 'abc_1', '2026-09-30T01:00:00Z', '/m/a.gguf');
        ins.run('live', 'abc_2', '2026-09-30T01:10:00Z', '/m/a.gguf');
        ins.run('llama-log-import', 'log:queue/leg1:0', '2026-09-30T02:00:00Z', '/m/b.gguf');
        ins.run('llama-log-import', 'log:queue/leg1:900', '2026-09-30T03:00:00Z', '/m/b.gguf');
        ins.run('llama-log-import', 'log:queue/leg2:0', '2026-09-30T04:00:00Z', '/m/c.gguf');
        assert.equal(db.countNonCsvRequests(), 3);
        const k = db.newestNonCsvRequestKeys(2);
        assert.deepEqual(k.map((r) => r.completed_at), ['2026-09-30T04:00:00Z', '2026-09-30T03:00:00Z']);
        const full = db.requestsByIds(k.map((r) => r.id));
        assert.equal(full.length, 2);
        assert.ok(full.every((r) => r.source === 'llama-log-import'));
        assert.deepEqual(db.requestsByIds([]), []);
        d.close();
    } finally {
        if (prev === undefined) delete process.env.BENCH_DB; else process.env.BENCH_DB = prev;
        delete require.cache[require.resolve('../lib/db')];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
