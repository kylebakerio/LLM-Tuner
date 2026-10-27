-- LL-Dash / codebench benchmark database. One file, WAL mode.
--
-- It is an INDEX, not the source of truth for codebench: every `runs` row is rebuilt from
-- codebench/results/<battery>/<task>.json by codebench/tools/db-rebuild.py, so `rm bench.sqlite &&
-- db-rebuild.py` is always safe. `requests` is different: LL-Dash writes it live (server4.js), and
-- the pre-SQLite history was imported once from logs/benchmarks.csv (source = 'csv-import').
--
-- Writers: Python owns `runs` (run.py + tools), Node owns `requests` (server4.js). `machines` and
-- `builds` are shared lookup tables keyed by fingerprint (INSERT OR IGNORE from either side).
-- Facets are NOT duplicated here: rows store the raw facts (launch command, build and machine
-- fingerprints, harness fields) and lib/models.js runDescriptor derives every facet and grouping
-- identity from them, so there is exactly one implementation of "what counts as the same config".

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS machines (
    fingerprint  TEXT PRIMARY KEY,         -- run.py machine_identity()['fingerprint']
    host         TEXT, cpu TEXT, cpu_threads INTEGER, ram_gib REAL, kernel TEXT, rocm TEXT,
    gpus_json    TEXT,                     -- per GPU: name, VRAM, driver, power limit, PCIe gen/width/hops
    static_json  TEXT,                     -- hand-kept facts (RAM modules/speed) from machine-static.json
    first_seen   TEXT, source TEXT
);

CREATE TABLE IF NOT EXISTS builds (
    fingerprint  TEXT PRIMARY KEY,         -- run.py build_identity()['fingerprint']
    dir          TEXT, build_info TEXT, cmake_json TEXT, built_at INTEGER, source TEXT
);

-- One codebench result file = one row. Row identity is the result file path.
CREATE TABLE IF NOT EXISTS runs (
    result_path      TEXT PRIMARY KEY,      -- results/<battery>/<task>.json (relative to codebench root)
    battery          TEXT NOT NULL,
    task             TEXT NOT NULL,
    task_version     TEXT,                  -- manifest.task_version (2026-09-24 on)
    started_at       TEXT,                  -- ISO UTC: manifest.started_at, else reconstructed (see time_source)
    time_source      TEXT,                  -- manifest | transcript_mtime | result_mtime
    status           TEXT, status_prev TEXT,
    solved           INTEGER, excluded INTEGER,
    wall_s           REAL, tokens_in INTEGER, tokens_out INTEGER, tool_calls INTEGER,
    edits            INTEGER, steps INTEGER,
    assertions_passed INTEGER, assertions_total INTEGER,
    runner           TEXT, runner_model TEXT, runner_version TEXT, effort TEXT, scaffold TEXT,
    prompt_level     TEXT, harness_mode TEXT, timeout_s REAL,
    provider         TEXT,                  -- local | cloud
    model_path       TEXT, n_ctx INTEGER, build_info TEXT,
    launch_command   TEXT, launch_source TEXT,
    build_fp         TEXT REFERENCES builds(fingerprint),
    machine_fp       TEXT REFERENCES machines(fingerprint),
    served_date      TEXT,                  -- cloud: the day it was served (model drift)
    anomalies_json   TEXT, server_busy_json TEXT,
    transcript_path  TEXT,
    indexed_at       TEXT,
    tokens_cached    INTEGER               -- prompt tokens served from cache (Claude cache reads, llama-server cache.read); tokens_in = NEW prompt tokens (2026-09-30)
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task);
CREATE INDEX IF NOT EXISTS runs_battery ON runs(battery);
CREATE INDEX IF NOT EXISTS runs_model ON runs(model_path);

-- One inference request served by a local llama-server.
CREATE TABLE IF NOT EXISTS requests (
    id               INTEGER PRIMARY KEY,
    source           TEXT NOT NULL,         -- live | csv-import
    csv_run_id       TEXT UNIQUE,           -- benchmarks.csv run_id (import idempotency; live rows get one too)
    completed_at     TEXT NOT NULL,         -- ISO UTC
    model_path       TEXT, launch_command TEXT,
    build_fp         TEXT REFERENCES builds(fingerprint),
    machine_fp       TEXT REFERENCES machines(fingerprint),
    n_ctx            INTEGER,
    prompt_tokens    INTEGER,               -- NEW tokens prefilled by this request
    depth_start      INTEGER,               -- tokens already in the slot before it (cache reuse); NULL = unknown
    depth_end        INTEGER,               -- tokens in the slot when it finished (llama: stop processing n_tokens)
    depth_source     TEXT,                  -- llama-log | transcript-join | NULL
    gen_tokens       INTEGER, reasoning_tokens INTEGER,
    prefill_tps      REAL, gen_tps REAL, prompt_latency_s REAL, wall_s REAL,
    prefill_tps_min REAL, prefill_tps_max REAL, gen_tps_min REAL, gen_tps_max REAL,
    draft_accept_rate REAL, draft_accepted INTEGER, draft_generated INTEGER, draft_mean_len REAL,
    aborted          INTEGER,
    telemetry_json   TEXT,                  -- GPU/CPU util, power, temps, VRAM at completion
    devices_json     TEXT, config_json TEXT
);
CREATE INDEX IF NOT EXISTS requests_time ON requests(completed_at);
CREATE INDEX IF NOT EXISTS requests_model ON requests(model_path);

-- Each request's telemetry sample series (2026-10-22): what Monitor's / History's expand chart draws. Written by
-- server4.js through lib/reqsamples.js for every queue lane's request (run_id rec:<queue label>:<proxy seq>, the id
-- the proxy-recording import gives it) and for LL-Dash's own server's (its CSV run_id). Bounded by count and age
-- there; not rebuildable (the live progress is gone once the request is over), and nothing else reads it.
CREATE TABLE IF NOT EXISTS request_samples (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL UNIQUE,
    source       TEXT NOT NULL,             -- lane | lldash
    lane         TEXT, item_id INTEGER,     -- the queue lane and item (lane rows)
    t_start      REAL,                      -- the proxy's request stamp (s): tells a re-run label's seq apart
    completed_at INTEGER NOT NULL,          -- ms
    n            INTEGER NOT NULL,          -- samples
    reason       TEXT,                      -- why there are fewer than 2 samples
    note         TEXT,                      -- what the samples are, when not plain live ticks
    samples_z    BLOB                       -- the samples' JSON (nulls dropped), deflate-raw
);
CREATE INDEX IF NOT EXISTS request_samples_time ON request_samples(completed_at);

-- ---------------------------------------------------------------- benchmark QUEUE (2026-09-25)
-- The queue that replaced the hand-written queueN.sh scripts. Rows are stored COMMANDS: editing the
-- plan is editing rows (Bench -> codebench -> Queue, or plain SQL). codebench/tools/queue_runner.py
-- executes them, one process per lane; lib/queue.js is the dashboard side. Nothing here is rebuilt
-- by db-rebuild.py (it only rewrites `runs`), so these tables are the source of truth for the queue.

-- One row per lane. `paused` stops the runner STARTING the next item (a running one carries on).
-- The runner stamps runner_* / heartbeat_at so the UI can tell a live runner from a dead one.
CREATE TABLE IF NOT EXISTS queue_lanes (
    lane          TEXT PRIMARY KEY,         -- local-gpu | cloud | (a test lane)
    paused        INTEGER NOT NULL DEFAULT 0,
    paused_by     TEXT, paused_at TEXT, note TEXT,
    config_json   TEXT,                     -- overrides of the runner's lane defaults (ports, lock, env_files)
    runner_pid    INTEGER, runner_host TEXT,
    runner_state  TEXT,                     -- idle | running | paused | held | waiting-lock | stopped
    runner_detail TEXT,
    heartbeat_at  TEXT,                     -- ISO UTC
    runtime_json  TEXT                      -- the runner's effective ports/GPUs (server/proxy/tap, devices); written at start
);

CREATE TABLE IF NOT EXISTS queue_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reused: queue_events keeps pointing at the right row
    lane          TEXT NOT NULL DEFAULT 'local-gpu',
    position      REAL NOT NULL,            -- order within the lane (float: insert between two rows)
    status        TEXT NOT NULL DEFAULT 'pending',
                  -- pending | running | done | failed | skipped | paused (held, the lane passes it) |
                  -- cancelled | interrupted (runner died while it ran; never re-run blindly)
    kind          TEXT NOT NULL DEFAULT 'run',   -- run | stage | wait | shell
    label         TEXT,                     -- battery name: results/<label>, sandbox /tmp/codebench-<label>
    runner        TEXT,                     -- opencode | claude
    model         TEXT,                     -- harness --model (opencode: bare id gets llama-local/ prefixed)
    launch_cmd    TEXT,                     -- llama-server command WITHOUT --port, as it would sit inside
                                            -- "..." in a queue script: may use $STOCK $D27MTP $Q4 $FLASH_*_CMD
    env_json      TEXT,                     -- extra environment, e.g. {"CODEBENCH_CLAUDE_EFFORT":"low"}
    tasks_json    TEXT,                     -- explicit task list (run items)
    task_source_json TEXT,                  -- computed at START time: {"from":"cascade",...} | {"from":"sql",...}
    approved_json TEXT,                     -- optional allow-list intersected with the computed set
    wait_json     TEXT,                     -- kind=wait: {"pid":N} | {"log":path,"pattern":re} | {"seconds":N}
    shell_cmd     TEXT,                     -- kind=shell: bash text, run with the lane's env files sourced
    sandbox       TEXT,                     -- default /tmp/codebench-<label>
    timeout_s     INTEGER DEFAULT 7200,     -- per-task cap (--timeout-s); kind=shell: the whole command
    record        INTEGER NOT NULL DEFAULT 0,   -- 1 = record-proxy --out results/<label>/requests.jsonl
    control       TEXT,                     -- requested on the RUNNING item: stop-after-task | stop-now
    notes         TEXT,
    created_by    TEXT,                     -- kyle | planner | claude | migration
    created_at    TEXT, updated_at TEXT, started_at TEXT, finished_at TEXT,
    resolved_tasks_json TEXT,               -- the task list actually handed to the harness
    result_dir    TEXT,                     -- absolute results/<label>
    log_path      TEXT,                     -- the item's log dir (harness.log, server.log, proxy.log)
    outcome_json  TEXT,                     -- {counts:{pass:n,...}, server_died, exit_code, reason, failed_set, ...}
    harness_pid   INTEGER, server_pid INTEGER, proxy_pid INTEGER, runner_pid INTEGER
);
CREATE INDEX IF NOT EXISTS queue_items_lane ON queue_items(lane, status, position);

-- Audit trail: every edit (dashboard / SQL tools) and every transition (runner).
CREATE TABLE IF NOT EXISTS queue_events (
    id       INTEGER PRIMARY KEY,
    at       TEXT NOT NULL,
    item_id  INTEGER, lane TEXT,
    actor    TEXT,                          -- runner | dashboard | migration | ...
    event    TEXT NOT NULL,                 -- insert | edit | move | claim | launch | start | end | ...
    detail_json TEXT
);
CREATE INDEX IF NOT EXISTS queue_events_item ON queue_events(item_id);

-- What a queued item is FOR, next to the row (2026-10-07; Bench -> codebench -> Queue shows it, lib/queue.js).
-- A side table, so nothing here touches the runner's rows: `question` = one line on what the item's results
-- will tell us, `est_hours` = a hand estimate (the fallback when the model + context has no past runs to time
-- it from), `user_note` = Kyle's own note, typed on the Queue page. Items may have no row.
CREATE TABLE IF NOT EXISTS queue_meta (
    item_id    INTEGER PRIMARY KEY,         -- queue_items.id
    question   TEXT,
    est_hours  REAL,
    user_note  TEXT,
    updated_at TEXT
);
