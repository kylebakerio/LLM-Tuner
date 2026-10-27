// Auto queue (Bench -> codebench -> Auto queue): the server half.
//   - the planner's SETTINGS, shared by the GUI and anything else that plans: logs/autoqueue.json
//   - the RUNNABLE model configs (catalog key, opencode id, launch command, weights path) and whether
//     each one can run right now (weights on disk)
//   - ENQUEUE (2026-09-25 on): an approved batch -> ROWS of the benchmark queue (lib/queue.js insertBatch:
//     run items, cascade stages chained by item id, cloud items with explicit effort + scaffold), which
//     codebench/tools/queue_runner.py executes and Bench -> codebench -> Queue shows and edits. Nothing is
//     started from here any more. The queueN.sh / cloudN.sh generator is kept as the PREVIEW / export:
//     dryRun writes the equivalent scripts to logs/autoqueue-dryrun/ and starts nothing.
//   - the enqueued batches and their state (read off the queue logs)
//   - EXPERIMENTS.md's open items as candidate pins
// The planner itself is ui/shared/planner.js (pure, runs in the browser); nothing here decides WHAT to run.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const LOGS = path.join(__dirname, '..', '..', 'logs');   // beside the dashboard directory, as server4.js LOGS_DIR
const SETTINGS_FILE = process.env.AUTOQUEUE_SETTINGS || path.join(LOGS, 'autoqueue.json');
const BATCHES_FILE = process.env.AUTOQUEUE_BATCHES || path.join(LOGS, 'autoqueue-batches.json');
const EXPERIMENTS_FILE = path.join(__dirname, '..', 'EXPERIMENTS.md');
const DEFAULT_QUEUE_DIR = path.join(HOME, '.claude', 'jobs', 'a16f4bd9', 'tmp');
const DRYRUN_DIR = path.join(LOGS, 'autoqueue-dryrun');
// The queue (lib/queue.js createQueue()), set by server4.js. Null in tests unless a test injects one via deps.queue.
let QUEUE = null;
function setQueue(q) { QUEUE = q; }

const HF27 = path.join(HOME, '.cache', 'huggingface', 'hub', 'models--unsloth--Qwen3.8-27B-GGUF', 'snapshots');
const Q4 = `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q4_K_XL.gguf`;
const EXPM = path.join(__dirname, '..', '..', 'models');
const DASH_DIR = path.join(__dirname, '..');
const CODEBENCH = process.env.CODEBENCH_ROOT || path.join(HOME, 'code', 'codebench');
// The launch variables a queue item may use ($STOCK, $D27MTP, $Q4 ...): the queue runner's own file. The generated
// script defines the same names from it, so a previewed leg and a queued one expand to the same command.
const VARS_FILE = path.join(CODEBENCH, 'tools', 'queue-vars.env');
// A file in a Hugging Face cache repo, whichever snapshot holds it (the path it WILL have while it downloads).
function hfFile(repo, file) {
    const snaps = `${HOME}/.cache/huggingface/hub/models--${repo.replace('/', '--')}/snapshots`;
    let dirs = []; try { dirs = fs.readdirSync(snaps); } catch { /* not downloaded yet */ }
    for (const d of dirs) if (fs.existsSync(path.join(snaps, d, file))) return path.join(snaps, d, file);
    return path.join(snaps, dirs[0] || 'main', file);
}
const Q36_27 = hfFile('unsloth/Qwen3.6-27B-MTP-GGUF', 'Qwen3.6-27B-UD-Q4_K_XL.gguf');
const Q36_35 = hfFile('unsloth/Qwen3.6-35B-A3B-MTP-GGUF', 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf');

// Runnable configs. `cmd` may use the variables the generated queue defines exactly as queue15.sh does:
// $STOCK, $D27MTP, $Q4 and flash-tuned.env's $FLASH_Q2_CMD / $FLASH_Q3_CMD / $FLASH_IQ4_CMD.
// `weights` is only for the on-disk check. `match` picks the model's fitted groups within its catalog key
// (thinking-off Qwen3.8-27B UD-Q4_K_XL is a config of the same weights in the catalog, and a separate contender here).
// `dbLike` / `dbExcludeLike` / `dbIncludeLike`: how the cascade finds this config's rows in bench.sqlite
// at run time (model_path LIKE, result_path NOT LIKE / LIKE), the same predicate as cascade.py.
const DEFAULT_MODELS = [
    { id: 'haiku-low-solo', label: 'Haiku 4.5 low solo', role: 'scout', lane: 'cloud', catalogKey: 'cloud:anthropic:claude-haiku-4-5@low/solo',
        runner: 'claude', claudeModel: 'claude-haiku-4-5', effort: 'low', scaffold: 'solo', family: 'claude-haiku-4-5' },
    { id: 'haiku-medium-solo', label: 'Haiku 4.5 medium solo', role: 'ignored', lane: 'cloud', catalogKey: 'cloud:anthropic:claude-haiku-4-5@medium/solo',
        runner: 'claude', claudeModel: 'claude-haiku-4-5', effort: 'medium', scaffold: 'solo', family: 'claude-haiku-4-5', priorShift: 0.3 },
    { id: 'ornith', label: 'Ornith-1.5-35B Q4_K_M', role: 'both', catalogKey: 'local:ornith-1.5-35b:q4-k-m', opencodeModel: 'ornith15-35b-a3b-64k', nCtx: 65536,
        weights: '/data/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-Q4_K_M.gguf', cmd: '$STOCK -m /data/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-Q4_K_M.gguf -c 65536 $D27MTP',
        dbLike: '%Ornith-1.5-35B-Q4_K_M%' },
    { id: 'swift', label: 'Swift Q4_K_L', role: 'scout', catalogKey: 'local:swift-qwen3.8-27b:q4-k-l', opencodeModel: 'swift-27b-128k', nCtx: 131072,
        weights: '/data/models/Swift-Qwen3.8-27B/Swift-Qwen3.8-27B-Q4_K_L.gguf', cmd: '$STOCK -m /data/models/Swift-Qwen3.8-27B/Swift-Qwen3.8-27B-Q4_K_L.gguf -c 131072 $D27MTP',
        dbLike: '%Swift-Qwen3.8-27B%' },
    { id: 'terse', label: 'Terse-Coder Q4_K_M', role: 'contender', catalogKey: 'local:qwen3.8-27b-terse-coder:q4-k-m', opencodeModel: 'terse-coder-128k', nCtx: 131072,
        weights: '/data/models/Terse-Coder-27B/Qwen3.8-27b-Terse-Coder.Q4_K_M.gguf', cmd: '$STOCK -m /data/models/Terse-Coder-27B/Qwen3.8-27b-Terse-Coder.Q4_K_M.gguf -c 131072 $D27MTP',
        dbLike: '%Terse-Coder%' },
    { id: 'q4', label: 'Qwen3.8-27B Q4_K_XL', role: 'contender', catalogKey: 'local:qwen3.8-27b:q4-k-xl', family: 'qwen3.8-27b',
        // 2026-10-15 (Kyle: "switch q4 and q6 to q8"): KV q8_0 on one XTX, the recipe of its 85-task row (item 1023 without L3);
        // the old entry ($D27MTP) launched KV f16, a row nothing is compared on.
        opencodeModel: 'local-128k', nCtx: 131072, weights: Q4, cmd: `$STOCK -m $Q4 -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm1 -dev ROCm1 --cache-type-k q8_0 --cache-type-v q8_0`,
        queueLane: 'local-rocm1', env: { CODEBENCH_DEVICES: 'ROCm1', LLAMA_ARG_CACHE_RAM: '2048' },
        dbLike: '%Qwen3.8-27B-UD-Q4_K_XL%', dbExcludeLike: '%nothink%' },
    { id: 'q4-nothink', label: 'Qwen3.8-27B Q4_K_XL thinking off', role: 'contender', catalogKey: 'local:qwen3.8-27b:q4-k-xl~nothink',
        opencodeModel: 'qwen38-27b-q4-128k-nothink', nCtx: 131072, weights: Q4, cmd: '$STOCK -m $Q4 -c 131072 $D27MTP --reasoning off',
        dbLike: '%Qwen3.8-27B-UD-Q4_K_XL%', dbIncludeLike: '%nothink%' },
    { id: 'q27-q3', label: 'Qwen3.8-27B Q3_K_XL', role: 'contender', catalogKey: 'local:qwen3.8-27b:q3-k-xl', family: 'qwen3.8-27b', priorShift: -0.2, relTimeGuess: 0.9,
        opencodeModel: 'qwen38-27b-q4-128k', nCtx: 131072, weights: `${EXPM}/Qwen3.8-27B-UD-Q3_K_XL.gguf`, cmd: `$STOCK -m ${EXPM}/Qwen3.8-27B-UD-Q3_K_XL.gguf -c 131072 $D27MTP`,
        dbLike: '%Qwen3.8-27B-UD-Q3_K_XL%' },
    // 2026-10-15 Kyle: "let's actually run it at a setup comparable to the q4 runs so we can get a genuine strength comparison
    // by quant" -- 128k, KV q8_0, one XTX, exactly the Q4_K_XL entry's launch with the Q2 file. Its 133 earlier runs (64k, KV q4_0,
    // 3060 / laptop 4090) stay their own config; the pair then measures what the short context + q4 KV cost.
    { id: 'q27-q2', label: 'Qwen3.8-27B Q2_K_XL', role: 'contender', catalogKey: 'local:qwen3.8-27b:q2-k-xl', family: 'qwen3.8-27b', priorShift: -0.6, relTimeGuess: 0.85,
        opencodeModel: 'local-128k', nCtx: 131072, weights: `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q2_K_XL.gguf`,
        cmd: `$STOCK -m ${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q2_K_XL.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm1 -dev ROCm1 --cache-type-k q8_0 --cache-type-v q8_0`,
        queueLane: 'local-rocm1', env: { CODEBENCH_DEVICES: 'ROCm1', LLAMA_ARG_CACHE_RAM: '2048' }, dbLike: '%Qwen3.8-27B-UD-Q2_K_XL%' },
    { id: 'q27-iq2', label: 'Qwen3.8-27B IQ2_XXS', role: 'contender', catalogKey: 'local:qwen3.8-27b:iq2-xxs', family: 'qwen3.8-27b', priorShift: -1.0, relTimeGuess: 0.8,
        opencodeModel: 'qwen38-27b-q4-128k', nCtx: 131072, weights: `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-IQ2_XXS.gguf`,
        cmd: `$STOCK -m ${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-IQ2_XXS.gguf -c 131072 $D27MTP`, dbLike: '%Qwen3.8-27B-UD-IQ2_XXS%' },
    { id: 'q27-q6', label: 'Qwen3.8-27B Q6_K_XL', role: 'contender', catalogKey: 'local:qwen3.8-27b:q6-k-xl', family: 'qwen3.8-27b', priorShift: 0.1, relTimeGuess: 1.3,
        opencodeModel: 'local-128k', nCtx: 131072, weights: `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q6_K_XL.gguf`,
        // 2026-10-15 (Kyle: "switch q4 and q6 to q8"): the recipe of all 73 scored Q6_K_XL runs (item 1036: tensor split, KV q8_0)
        cmd: `$MOE -m ${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q6_K_XL.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm0 -dev ROCm0,ROCm1 -sm tensor --cache-type-k q8_0 --cache-type-v q8_0`,
        queueLane: 'local-gpu', env: { CODEBENCH_DEVICES: 'ROCm0,ROCm1', CODEBENCH_ROW_VARIANT: 'tensor-split-two-xtx' }, dbLike: '%Qwen3.8-27B-UD-Q6_K_XL%' },
    { id: 'flash-q2', label: 'Flash-Next Q2_K_XL', role: 'contender', catalogKey: 'local:qwen3.8-flash-next:q2-k-xl', family: 'qwen3.8-flash-next',
        opencodeModel: 'flash-next-64k-nc33', nCtx: 65536, weights: `${EXPM}/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf`, cmd: '$FLASH_Q2_CMD', dbLike: '%Flash-Next-UD-Q2_K_XL%' },
    { id: 'flash-iq4', label: 'Flash-Next IQ4_XS', role: 'contender', catalogKey: 'local:qwen3.8-flash-next:iq4-xs', family: 'qwen3.8-flash-next',
        opencodeModel: 'flash-next-64k', nCtx: 65536, weights: `${EXPM}/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf`, cmd: '$FLASH_IQ4_CMD', dbLike: '%Flash-Next-UD-IQ4_XS%' },
    // Qwen3.6 test runs (2026-09-25): build-all, the 27B placement; $D27MTP assumes the GGUF carries an MTP head
    // (use $D27 in the launch command if it does not). role 'ignored' until they have results to plan with.
    { id: 'q36-27b-q4', label: 'Qwen3.6-27B Q4_K_XL', role: 'ignored', catalogKey: 'local:qwen3.6-27b:q4-k-xl', family: 'qwen3.6-27b',
        opencodeModel: 'qwen36-27b-q4-128k', nCtx: 131072, weights: Q36_27, cmd: `$STOCK -m ${Q36_27} -c 131072 $D27MTP`, dbLike: '%Qwen3.6-27B-UD-Q4_K_XL%' },
    { id: 'q36-35b-a3b-q4', label: 'Qwen3.6-35B-A3B Q4_K_XL', role: 'ignored', catalogKey: 'local:qwen3.6-35b-a3b:q4-k-xl', family: 'qwen3.6-35b-a3b',
        opencodeModel: 'qwen36-35b-a3b-q4-64k', nCtx: 65536, weights: Q36_35, cmd: `$STOCK -m ${Q36_35} -c 65536 $D27MTP`, dbLike: '%Qwen3.6-35B-A3B-UD-Q4_K_XL%' },
    { id: 'flash-q3', label: 'Flash-Next Q3_K_XL', role: 'ignored', catalogKey: 'local:qwen3.8-flash-next:q3-k-xl', family: 'qwen3.8-flash-next',
        opencodeModel: 'flash-next-64k', nCtx: 65536, weights: `${EXPM}/Qwen3.8-Flash-Next-UD-Q3_K_XL-00001-of-00003.gguf`, cmd: '$FLASH_Q3_CMD', dbLike: '%Flash-Next-UD-Q3_K_XL%' },
    // 2026-10-15 (focus set): the two configs Kyle is comparing that had no entry. Launch, cards and row variant as the queue
    // items they have been running under (Q8_K_XL: items 1036/1048, tensor split over both XTX, KV q8_0; Flash-Next GSQ-RCO
    // IQ3_XXS: item 944, Strata 0.1.43.1 on the first XTX). `queueLane` = the queue lane its rows go to; `env` = the row env.
    { id: 'q27-q8', label: 'Qwen3.8-27B Q8_K_XL', role: 'contender', catalogKey: 'local:qwen3.8-27b:q8-k-xl', family: 'qwen3.8-27b', priorShift: 0.15, relTimeGuess: 1.5,
    // 2026-10-16: n_max 3 measured 64.2 vs 52.0 tok/s on a 32k-prompt sweep, but in real 262k review runs it was flat
    // (item 1070 45.1 tok/s at 3 vs item 1056 45.0 at 2; acceptance 0.55 vs 0.61) and changes temp-0 text, so it stays at 2.
        opencodeModel: 'local-128k', nCtx: 131072, weights: `${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q8_K_XL.gguf`,
        cmd: `$MOE -m ${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q8_K_XL.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm0 -dev ROCm0,ROCm1 -sm tensor --cache-type-k q8_0 --cache-type-v q8_0`,
        queueLane: 'local-gpu', env: { CODEBENCH_DEVICES: 'ROCm0,ROCm1', CODEBENCH_ROW_VARIANT: 'tensor-split-two-xtx' }, dbLike: '%Qwen3.8-27B-UD-Q8_K_XL%' },
    { id: 'fn-gsq-iq3xxs', label: 'Flash-Next GSQ-RCO IQ3_XXS (Strata)', role: 'contender', catalogKey: 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs', family: 'qwen3.8-flash-next-gsq-rco',
        opencodeModel: 'local-128k', nCtx: 131072, weights: path.join(HOME, 'AI', 'Strata-0.1.43.1', 'strata-iq3_xxs.json'),
        cmd: `${path.join(HOME, 'AI', 'Strata-0.1.43.1', 'queue-serve.sh')} ${path.join(HOME, 'AI', 'Strata-0.1.43.1', 'strata-iq3_xxs.json')}`,
        queueLane: 'local-gpu', env: { CODEBENCH_DEVICES: 'ROCm0' }, dbLike: '%/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf' },
    // 2026-10-15 Kyle: "the best flash next we can run ... max strength, so that also means maximum context": UD-IQ4_XS on
    // Strata 0.1.43.1 over both XTX at the native 262,144 (item 1055's launch). 2026-10-16 calibration: Strata 0.1.44.1,
    // pipeline windows 2 + kernel-copy stall fix + --spec 3 --spec-min-p 0.7 (same temp-0 text, ~+20% decode).
    // catalogKey (2026-10-19): the Strata row of this file, where every Strata UD-IQ4_XS run lands now that the speed-only
    // config-name parts (2xtx, pw2, kcopy, spec3) no longer split it (lib/models.js strataVariant); the plain key is the
    // llama.cpp UD-IQ4_XS row (flash-iq4 above)
    { id: 'fn-udiq4xs-strata-262k', label: 'Flash-Next UD-IQ4_XS (Strata, 262k)', role: 'contender', catalogKey: 'local:qwen3.8-flash-next:iq4-xs~strata', family: 'qwen3.8-flash-next',
        opencodeModel: 'local-262k', nCtx: 262144, weights: path.join(HOME, 'AI', 'Strata-0.1.44.1', 'strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3.json'),
        cmd: `${path.join(HOME, 'AI', 'Strata-0.1.44.1', 'queue-serve.sh')} ${path.join(HOME, 'AI', 'Strata-0.1.44.1', 'strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3.json')}`,
        queueLane: 'local-gpu', env: { CODEBENCH_DEVICES: 'ROCm0,ROCm1' }, dbLike: '%/data/models/Qwen3.8-Flash-Next/UD-IQ4_XS/%' },
];
// Queue lanes a local config may name as its `queueLane` (lib/queue.js lanes; local-xtx / local-3060 are parked on purpose).
const QUEUE_LANES = ['local-gpu', 'local-rocm1', 'laptop-4090', 'laptop-3060'];

const DEFAULT_SETTINGS = {
    version: 1,
    weights: { top: 1, speed: 0.6, difficulty: 0.8 },
    strategy: 'greedy', blendShare: 0.5,
    repeatDiscount: 0.3, topK: 6, topIncludeCloud: false, roleBias: 0.3, focusWidth: 1.0, speedTargetShared: 10,
    validity: { minStrong: 4, strongGap: 1.0 },
    priors: { family: true, familyTau: 0.5, familyMinN: 12, untriedB: 1.5, untriedSE: 1.5, taskB: {} },
    minValue: 0.05,
    rerunScored: false,      // the planner offers tasks a config already ran (ui/shared/planner.js); off = one run per task per config
    // SCORING (2026-10-18, Kyle: "primarily test ones where we are relatively unsure if it will pass or fail ... time as the
    // secondary (but still important) factor"): 'info' = expected information a^2 p(1-p) of a run at the leaderboard fit's own
    // p, divided by minutes^timeGamma; 'legacy' = the TOP / SPEED / DIFFICULTY value per minute (ui/shared/planner.js header)
    scoring: 'info', timeGamma: 0.4, minInfo: 0.02,
    budget: { localHours: 8, cloud: true, cloudHours: 2, switchMin: 5 },
    defaultWall: { solveMin: 20, failMin: 60 },
    cascade: { order: ['haiku-low-solo', 'ornith', 'swift', 'terse', 'q4', 'flash-q2', 'flash-iq4'], minReach: 0.25 },
    pins: [],
    // FOCUS SET (2026-10-15): the configs to plan for, [{model: <models[].id>, promptLevel?: 'L2' | 'L3'}] (empty = every
    // non-ignored config, as before). An L3 entry is its own config `<id>.L3` (expandFocus).
    focus: [],
    balance: 1,              // coverage balancing among focus configs (ui/shared/planner.js balanceFactor); 0 = off
    chunkTasks: 4,           // tasks per queue row; rows of a lane are interleaved across configs (planner chunkSchedule); 0 = one row per config
    // CONTINUOUS REFILL (opt-in, off): keep each listed lane topped up with planner work for the focus configs on it. Every
    // `intervalMin` the server checks each lane in `lanes`; one whose pending planner rows estimate under `minHours` gets a plan
    // of `topUpHours`. Paused lanes are skipped (and cannot be added while paused); cloud is never refilled.
    refill: { enabled: false, lanes: [], minHours: 3, topUpHours: 6, intervalMin: 15 },
    // LANE FLOOR (2026-10-21, Kyle: "lanes should never be sitting empty ... empty lanes should get populated and not waste
    // time"): every `intervalMin` each unpaused lane in `lanes` whose queued work (ALL its pending + running items, whoever
    // made them) estimates under `hours` gets work: first the oldest held item of that lane whose notes START with
    // "[backlog]" (released), else `topUpHours` of its configs' gaps against the `reference` row -- the problems that row has
    // run and the config's row has not, hardest first by the Models page fit (Kyle 10-21: "match all of the q8 27b runs,
    // passes and fails, starting from hardest"). A config is an existing queue item (`template`): its launch, env and runner
    // are copied, so a floor row is exactly that row's config. Strongest config first (the fit's low end). Never cloud.
    floor: {
        enabled: false, hours: 3, topUpHours: 6, intervalMin: 10, chunkTasks: 4, compositeChunk: 2, compositeTimeoutS: 10800,
        reference: { template: 1220, label: 'Qwen3.8-27B Q8_K_XL 131k' },
        fieldFallback: true,   // when the reference row's gaps are all run or queued: problems any row has run (first runs)
        // never fed, whatever a config list says: a launch matching one of these, or a template item whose notes say BACKBURNER
        never: [{ pattern: 'Flash-Next-UD-Q2_K_XL', why: 'Kyle 10-21: Flash-Next UD-Q2_K_XL on one XTX (experts streamed from /data) is on the backburner, "too inefficient to run as a single card config"' },
            { pattern: 'Flash-Next', lanes: ['local-rocm1'], why: 'no Flash-Next on the second XTX: a Flash-Next server takes 28-43 GB of RAM and belongs to local-gpu (10-21)' },
            { pattern: 'Strata', lanes: ['local-rocm1'], why: 'no Strata engine on the second XTX: its Flash-Next configs belong to local-gpu (10-21)' }],
        lanes: {
            'local-gpu': [
                { id: 'fn-gsq-iq3xxs', label: 'Flash-Next GSQ-RCO IQ3_XXS (Strata, ROCm0)', template: 1225 },
                { id: 'fn-ud-iq4xs', label: 'Flash-Next UD-IQ4_XS (Strata 262k, two XTX)', template: 1224 },
                { id: 'fn-ud-q4kxl', label: 'Flash-Next UD-Q4_K_XL (Strata 262k, two XTX)', template: 1221 },
            ],
            'local-rocm1': [{ id: 'q27-q4kxl-rocm1', label: 'Qwen3.8-27B UD-Q4_K_XL 128k KV q8_0 (ROCm1)', template: 1232 }],
            'laptop-4090': [{ id: 'q27-q2kxl-laptop4090', label: 'Qwen3.8-27B UD-Q2_K_XL 64k KV q4_0 (laptop 4090)', template: 1227 }],
            'laptop-3060': [{ id: 'q27-gsq-iq2xs-laptop3060', label: 'Qwen3.8-27B GSQ-RCO IQ2_XS 80k KV q4_0 (laptop 3060)', template: 1041 }],
        },
    },
    models: DEFAULT_MODELS,
    queue: { dir: DEFAULT_QUEUE_DIR, codebench: CODEBENCH, timeoutS: 7200 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

// A saved entry that still carries an OLD DEFAULT verbatim (every settings save writes the whole models list, so a file saved
// before a default changed shadows the new one) is read as the default it was: those fields are dropped, nothing is written
// back. Only exact matches: a value the user edited stays theirs.
const STALE_DEFAULTS = {
    // 2026-10-15: Q4_K_XL / Q6_K_XL moved from KV f16 ($D27MTP) to the KV q8_0 recipes of their scored rows
    'q4': { opencodeModel: 'qwen38-27b-q4-128k', cmd: '$STOCK -m $Q4 -c 131072 $D27MTP' },
    'q27-q6': { opencodeModel: 'qwen38-27b-q4-128k', cmd: `$STOCK -m ${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q6_K_XL.gguf -c 131072 $D27MTP` },
    // 2026-10-15: Q2_K_XL moved to the Q4_K_XL entry's setup (128k KV q8_0, one XTX; see DEFAULT_MODELS)
    'q27-q2': { opencodeModel: 'qwen38-27b-q4-128k', nCtx: 131072,
        cmd: `$STOCK -m ${HF27}/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q2_K_XL.gguf -c 131072 $D27MTP` },
    // 2026-10-16: Flash-Next UD-IQ4_XS moved from Strata 0.1.43.1's plain two-XTX split to the 0.1.44.1 spec 3 + pipeline
    // windows 2 + kernel copy config (see DEFAULT_MODELS); logs/autoqueue.json still carried the old entry verbatim, so a
    // queue item inserted from its preset ran the old config (found 2026-10-17)
    // An id may list several stale sets, each dropped on its own when all of its fields match.
    // 2026-10-19: the plain catalogKey is the llama.cpp UD-IQ4_XS row, never this Strata config's (its row is `~strata` now,
    // lib/models.js strataVariant); logs/autoqueue.json carries the plain key, which pointed the planner at the 6 llama.cpp
    // tasks instead of this config's own (HANDOFF 10-18 "still open")
    'fn-udiq4xs-strata-262k': [{ weights: path.join(HOME, 'AI', 'Strata-0.1.43.1', 'strata-ud-iq4_xs-262k-int8-2xtx.json'),
        cmd: `${path.join(HOME, 'AI', 'Strata-0.1.43.1', 'queue-serve.sh')} ${path.join(HOME, 'AI', 'Strata-0.1.43.1', 'strata-ud-iq4_xs-262k-int8-2xtx.json')}` },
        { catalogKey: 'local:qwen3.8-flash-next:iq4-xs' }],
};
function dropStale(m) {
    const sets = m && STALE_DEFAULTS[m.id];
    if (!sets) return m;
    let out = m;
    for (const old of Array.isArray(sets) ? sets : [sets]) {
        if (!Object.entries(old).every(([k, v]) => m[k] === v)) continue;
        if (out === m) out = { ...m };
        for (const k of Object.keys(old)) delete out[k];
    }
    return out;
}
function mergeModels(saved) {
    const D = clone(DEFAULT_MODELS);
    if (!Array.isArray(saved) || !saved.length) return D;
    const byId = new Map(saved.filter((m) => m && m.id).map((m) => [m.id, dropStale(m)]));
    return [...D.map((m) => ({ ...m, ...(byId.get(m.id) || {}) })), ...saved.filter((m) => m && m.id && !D.some((d) => d.id === m.id))].map(withVariantKey);
}
/**
 * THINKING OFF IS ITS OWN ROW (2026-10-15, Kyle: "Thinking off should NEVER be blended with thinking on"). The catalog has
 * filed --reasoning off runs under `<model>~nothink` since 2026-10-01; configs written before that told them apart with
 * `match: { runnerModelIncludes / runnerModelExcludes: 'nothink' }` on the runner's model id -- which a local config does
 * not have (lib/models.js runDescriptor: the opencode alias is not the model), so the thinking-off config matched NO
 * group (all its tasks looked unrun) and the plain one matched only by luck. A saved config of that shape is read as the
 * key it means; nothing is written back. A config whose launch turns thinking off gets the ~nothink key the same way.
 */
function withVariantKey(m) {
    if (!m || typeof m.catalogKey !== 'string' || !/^local:/.test(m.catalogKey)) return m;
    const mt = m.match || {};
    const off = mt.runnerModelIncludes === 'nothink' || /(?:^|\s)(?:--reasoning|-rea)\s+off(?:\s|$)|(?:^|\s)--reasoning-budget\s+0(?:\s|$)/.test(String(m.cmd || ''));
    const out = { ...m };
    if (mt.runnerModelIncludes === 'nothink' || mt.runnerModelExcludes === 'nothink') {
        const rest = { ...mt }; delete rest.runnerModelIncludes; delete rest.runnerModelExcludes;
        if (Object.keys(rest).length) out.match = rest; else delete out.match;
    }
    if (off && !m.catalogKey.split('~').includes('nothink')) out.catalogKey = `${m.catalogKey}~nothink`;
    return out;
}
/** Saved settings over the defaults. A saved `models` list replaces the default one wholesale. */
function loadSettings() {
    const saved = readJson(SETTINGS_FILE, {}) || {};
    const D = clone(DEFAULT_SETTINGS);
    const out = { ...D, ...saved };
    for (const k of ['weights', 'validity', 'priors', 'budget', 'defaultWall', 'cascade', 'queue', 'refill', 'floor']) out[k] = { ...D[k], ...(saved[k] || {}) };
    if (!Array.isArray(out.focus)) out.focus = [];
    // models merge BY ID: a saved entry overlays its default (role, priorShift, cmd...), saved-only ids are
    // appended, so a config added to DEFAULT_MODELS later still reaches a settings file saved before it
    out.models = mergeModels(saved.models);
    if (!Array.isArray(out.pins)) out.pins = [];
    return out;
}

const ROLES = new Set(['scout', 'contender', 'both', 'ignored']);
const STRATS = new Set(['greedy', 'cascade', 'blend']);
/** Validate and save. Throws with a message on anything malformed; returns the merged settings. */
function saveSettings(body, deps = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('settings must be an object');
    const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be a number in [${lo}, ${hi}]`); return n; };
    const cur = loadSettings();
    const s = { ...cur, ...body };
    for (const k of ['weights', 'validity', 'priors', 'budget', 'defaultWall', 'cascade', 'queue', 'refill', 'floor']) s[k] = { ...cur[k], ...(body[k] || {}) };
    for (const k of ['top', 'speed', 'difficulty']) s.weights[k] = num(s.weights[k], 0, 10, `weights.${k}`);
    if (!STRATS.has(s.strategy)) throw new Error('strategy must be greedy, cascade or blend');
    s.blendShare = num(s.blendShare, 0, 1, 'blendShare');
    s.repeatDiscount = num(s.repeatDiscount, 0, 1, 'repeatDiscount');
    s.topK = Math.round(num(s.topK, 2, 20, 'topK'));
    s.roleBias = num(s.roleBias, 0, 1, 'roleBias');
    s.validity.minStrong = Math.round(num(s.validity.minStrong, 1, 50, 'validity.minStrong'));
    s.validity.strongGap = num(s.validity.strongGap, 0, 5, 'validity.strongGap');
    s.budget.localHours = num(s.budget.localHours, 0, 168, 'budget.localHours');
    s.budget.cloudHours = num(s.budget.cloudHours, 0, 168, 'budget.cloudHours');
    s.budget.switchMin = num(s.budget.switchMin, 0, 120, 'budget.switchMin');
    s.budget.cloud = !!s.budget.cloud;
    s.rerunScored = s.rerunScored === true;
    if (!['info', 'legacy'].includes(s.scoring)) throw new Error('scoring must be info or legacy');
    s.timeGamma = num(s.timeGamma, 0, 2, 'timeGamma');
    s.minInfo = num(s.minInfo, 0, 1, 'minInfo');
    s.priors.family = !!s.priors.family;
    s.priors.untriedB = num(s.priors.untriedB, -5, 5, 'priors.untriedB');
    s.priors.familyTau = num(s.priors.familyTau, 0.05, 5, 'priors.familyTau');
    if (!Array.isArray(s.models)) throw new Error('models must be a list');
    s.models = mergeModels(s.models);
    const ids = new Set();
    for (const m of s.models) {
        if (!m || !m.id || !/^[\w.-]+$/.test(m.id)) throw new Error(`model id "${m && m.id}" must be [A-Za-z0-9_.-]`);
        if (ids.has(m.id)) throw new Error(`duplicate model id ${m.id}`); ids.add(m.id);
        if (!ROLES.has(m.role || 'ignored')) throw new Error(`model ${m.id}: role must be scout, contender, both or ignored`);
    }
    if (!Array.isArray(s.pins)) throw new Error('pins must be a list');
    for (const p of s.pins) if (!p || !ids.has(p.model)) throw new Error(`pin for unknown model ${p && p.model}`);
    s.cascade.order = (s.cascade.order || []).filter((id) => ids.has(id));
    for (const m of s.models) {
        if (m.queueLane != null && m.queueLane !== '' && !/^[\w.-]+$/.test(String(m.queueLane))) throw new Error(`model ${m.id}: queueLane must be a lane name`);
        if (m.env != null && (typeof m.env !== 'object' || Array.isArray(m.env) || Object.entries(m.env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v === 'object')))
            throw new Error(`model ${m.id}: env must be {NAME: "value"}`);
    }
    // focus set
    if (!Array.isArray(s.focus)) throw new Error('focus must be a list');
    const seenF = new Set();
    s.focus = s.focus.map((f) => {
        const o = typeof f === 'string' ? { model: f } : f;
        if (!o || !ids.has(o.model)) throw new Error(`focus: unknown model ${o && o.model}`);
        const promptLevel = String(o.promptLevel || 'L2').toUpperCase();
        if (!/^L[123]$/.test(promptLevel)) throw new Error(`focus ${o.model}: promptLevel must be L1, L2 or L3`);
        return { model: o.model, ...(promptLevel !== 'L2' ? { promptLevel } : {}) };
    }).filter((f) => { const k = `${f.model}|${f.promptLevel || 'L2'}`; if (seenF.has(k)) return false; seenF.add(k); return true; });
    s.balance = num(s.balance, 0, 5, 'balance');
    s.chunkTasks = Math.round(num(s.chunkTasks, 0, 50, 'chunkTasks'));
    // refill: off by default; a lane cannot be switched on while it is paused (Kyle: respect lane pauses)
    s.refill.enabled = s.refill.enabled === true;
    s.refill.minHours = num(s.refill.minHours, 0, 72, 'refill.minHours');
    s.refill.topUpHours = num(s.refill.topUpHours, 0.25, 72, 'refill.topUpHours');
    s.refill.intervalMin = Math.round(num(s.refill.intervalMin, 1, 1440, 'refill.intervalMin'));
    if (!Array.isArray(s.refill.lanes)) throw new Error('refill.lanes must be a list');
    s.refill.lanes = [...new Set(s.refill.lanes.map(String))];
    for (const l of s.refill.lanes) {
        if (!/^[\w.-]+$/.test(l)) throw new Error(`refill: bad lane ${l}`);
        if (l === 'cloud') throw new Error('refill never runs on the cloud lane (cloud runs need Kyle\'s OK)');
    }
    const wasOn = new Set(cur.refill && cur.refill.enabled ? (cur.refill.lanes || []) : []);
    const newlyOn = s.refill.enabled ? s.refill.lanes.filter((l) => !wasOn.has(l)) : [];
    if (newlyOn.length) {
        const q = deps.queue || QUEUE;
        let paused = [];
        try { paused = q ? q.lanes().filter((l) => l.paused && newlyOn.includes(l.lane)).map((l) => l.lane) : []; } catch { paused = []; }
        if (paused.length) throw new Error(`refill cannot be switched on for ${paused.join(', ')}: the lane is paused (resume it first)`);
    }
    // floor: lanes -> configs, each an existing queue item; never the cloud lane
    s.floor.enabled = s.floor.enabled === true;
    s.floor.hours = num(s.floor.hours, 0, 72, 'floor.hours');
    s.floor.topUpHours = num(s.floor.topUpHours, 0.25, 72, 'floor.topUpHours');
    s.floor.intervalMin = Math.round(num(s.floor.intervalMin, 1, 1440, 'floor.intervalMin'));
    s.floor.chunkTasks = Math.round(num(s.floor.chunkTasks, 1, 50, 'floor.chunkTasks'));
    s.floor.compositeChunk = Math.round(num(s.floor.compositeChunk, 1, 10, 'floor.compositeChunk'));
    s.floor.compositeTimeoutS = Math.round(num(s.floor.compositeTimeoutS, 600, 86400, 'floor.compositeTimeoutS'));
    if (!s.floor.reference || !Number.isInteger(Number(s.floor.reference.template))) throw new Error('floor.reference.template must be a queue item id');
    if (!s.floor.lanes || typeof s.floor.lanes !== 'object' || Array.isArray(s.floor.lanes)) throw new Error('floor.lanes must be {lane: [configs]}');
    if (!Array.isArray(s.floor.never) || s.floor.never.some((n) => !n || typeof n.pattern !== 'string' || !n.pattern)) throw new Error('floor.never must be a list of {pattern, why, lanes?}');
    for (const [lane, list] of Object.entries(s.floor.lanes)) {
        if (!/^[\w.-]+$/.test(lane)) throw new Error(`floor: bad lane ${lane}`);
        if (lane === 'cloud') throw new Error('the floor never fills the cloud lane (cloud runs need Kyle\'s OK)');
        if (!Array.isArray(list)) throw new Error(`floor.lanes.${lane} must be a list`);
        for (const c of list) if (!c || !/^[\w.-]+$/.test(String(c.id || '')) || !Number.isInteger(Number(c.template))) throw new Error(`floor.lanes.${lane}: each config needs an id and a template item id`);
    }
    writeJsonAtomic(SETTINGS_FILE, s);
    return s;
}

/** The focus list -> extra configs + focus ids (the browser's copy is ui/shared/planner.js expandFocus; a test keeps them equal). */
function expandFocus(models, focus) {
    const out = (models || []).slice();
    const ids = [];
    for (const f of focus || []) {
        const base = f && (models || []).find((m) => m && m.id === f.model);
        if (!base) continue;
        const lvl = String(f.promptLevel || 'L2').toUpperCase();
        if (!/^L[123]$/.test(lvl)) continue;
        if (lvl === (base.promptLevel || 'L2')) { if (!ids.includes(base.id)) ids.push(base.id); continue; }
        const id = `${base.id}.${lvl}`;
        if (!out.some((m) => m.id === id)) {
            out.push({ ...base, id, label: `${base.label || base.id} · ${lvl}`, promptLevel: lvl, focusOf: base.id,
                env: { ...(base.env || {}), CODEBENCH_PROMPT_LEVEL: lvl } });
        }
        if (!ids.includes(id)) ids.push(id);
    }
    return { models: out, focus: ids };
}
/** Settings whose `models` include the focus set's prompt-level configs: what the queue needs to look an `<id>.L3` leg up. */
function plannerSettings(settings) {
    const ex = expandFocus(settings.models || [], settings.focus || []);
    return { ...settings, models: ex.models, focusIds: ex.focus };
}

/** Task ids with a prompt at `level` (codebench tasks/<repo>/<id>/prompt-<level>.md; L2 = prompt.md): run.py runs only
 *  those at that level. Cached for 10 minutes. */
const promptCache = new Map();
function promptLevelTasks(level, root = path.join(CODEBENCH, 'tasks')) {
    const lvl = String(level || 'L2').toUpperCase();
    const k = `${root}|${lvl}`;
    const hit = promptCache.get(k);
    if (hit && Date.now() - hit.at < 600000) return hit.v;
    const file = lvl === 'L2' ? 'prompt.md' : `prompt-${lvl}.md`;
    const out = [];
    const walk = (dir, depth) => {
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        if (ents.some((e) => e.isFile() && e.name === 'task.yaml')) { if (ents.some((e) => e.isFile() && e.name === file)) out.push(path.basename(dir)); return; }
        if (depth < 3) for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    };
    walk(root, 0);
    out.sort();
    promptCache.set(k, { at: Date.now(), v: out });
    return out;
}
/** {L1: [...], L3: [...]} for the levels the focus set uses (what derive.js restricts those configs to). */
function promptTasksFor(settings) {
    const levels = [...new Set((settings.focus || []).map((f) => String(f.promptLevel || 'L2').toUpperCase()).filter((l) => l !== 'L2'))];
    return Object.fromEntries(levels.map((l) => [l, promptLevelTasks(l)]));
}

/** Can each runnable config run now? {id: {ok, reason}} (a focus entry's `<id>.L3` config is listed too: its base's answer) */
function availability(settings) {
    const out = {};
    for (const m of plannerSettings(settings).models || []) {
        if ((m.lane || (m.runner === 'claude' ? 'cloud' : 'local')) === 'cloud') {
            out[m.id] = m.effort ? { ok: true } : { ok: false, reason: 'has no effort level (runs without one cannot be labelled)' };
            continue;
        }
        if (!m.cmd || !m.opencodeModel) { out[m.id] = { ok: false, reason: 'has no launch command / opencode model id' }; continue; }
        if (m.weights && !fs.existsSync(m.weights)) { out[m.id] = { ok: false, reason: `weights missing: ${m.weights}` }; continue; }
        out[m.id] = { ok: true };
    }
    return out;
}

// ------------------------------------------------------------------ queue chaining
function processArgs() {
    try { return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf-8', timeout: 5000 }).split('\n'); } catch { return []; }
}
/**
 * The newest queueN.sh in `dir`: done (its log has "QUEUEn DONE"), alive (a bash process runs it).
 * A new queue waits for it unless it is done; if it is neither done nor alive, waiting would hang forever,
 * so `warning` says so and the new queue does not wait.
 */
function detectChain(dir = DEFAULT_QUEUE_DIR, psArgs = null) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* none */ }
    const nums = names.map((f) => /^queue(\d+)\.sh$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
    const prev = nums.length ? Math.max(...nums) : 0;
    if (!prev) return { prev: null, next: 1, waitFor: null, done: true, alive: false, warning: null };
    let log = ''; try { log = fs.readFileSync(path.join(dir, `queue${prev}.log`), 'utf-8'); } catch { /* not started */ }
    const done = new RegExp(`QUEUE${prev} DONE`).test(log);
    const args = psArgs || processArgs();
    const alive = args.some((a) => new RegExp(`(^|/|\\s)queue${prev}\\.sh(\\s|$)`).test(a) && /bash/.test(a));
    const warning = !done && !alive ? `queue${prev} has no DONE line and is not running: the new queue will not wait for it` : null;
    return { prev, next: prev + 1, waitFor: !done && alive ? prev : null, done, alive, warning, lastLine: log.trim().split('\n').slice(-1)[0] || '' };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const safeTask = (t) => { if (!/^[\w.-]+$/.test(t)) throw new Error(`bad task id ${t}`); return t; };

/**
 * The local queue script. batch.legs: [{model, lane, cascade?, runs: [{task}]}] (local legs only are
 * used); batch.cascade: {order: [ids], seed: [tasks]} when any leg is a cascade stage.
 */
function generateQueueScript(batch, settings, { n, waitFor, dir, logDir, vars }) {
    const q = settings.queue || DEFAULT_SETTINGS.queue;
    const byId = new Map((settings.models || []).map((m) => [m.id, m]));
    const T = dir; const LD = logDir || dir;
    const legs = (batch.legs || []).filter((L) => (L.lane || 'local') === 'local' && L.runs && L.runs.length);
    const L = [];
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    L.push('#!/bin/bash');
    L.push(`# Queue v${n} (${now}): generated by LL-Dash Auto queue (Bench -> codebench -> Auto queue), from queue15.sh's pattern.`);
    L.push(`# ${legs.length} leg(s), ${legs.reduce((a, x) => a + x.runs.length, 0)} run(s); strategy ${batch.strategy || '?'}; planned ${batch.plannedAt || now}.`);
    for (const leg of legs) {
        const m = byId.get(leg.model) || {};
        L.push(`#   ${leg.cascade != null ? `cascade stage ${leg.cascade}` : 'leg'}: ${m.label || leg.model}: ${leg.runs.map((r) => r.task).join(' ')}`);
    }
    L.push(`L=${LD}/queue${n}.log`);
    L.push(`T=${T}`);
    L.push(`CB=${q.codebench}`);
    L.push(`DASH=${DASH_DIR}`);
    L.push('LOCK=/tmp/codebench-lldash.lock');
    L.push('export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$HOME/.local/bin:$HOME/.opencode/bin:$PATH"');
    L.push(`say(){ echo "[$(date +%H:%M)] $*" >> "$L"; }
disk(){ df -h / /data | tail -2 | awk '{print "   disk", $6, $4, "free", $5}' >> "$L"; }
healthy(){ curl -s -m 10 http://127.0.0.1:\${1:-8080}/health 2>/dev/null | grep -q ok; }
release_port(){
  local port=\${1:-8080} i pid
  for i in $(seq 1 15); do ! ss -ltn 2>/dev/null | grep -Eq "127\\.0\\.0\\.1:$port " && return 0; sleep 2; done
  pid=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep '127.0.0.1' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -n "$pid" ] && { say "   $port still held by pid $pid -- stopping it"; kill "$pid"; sleep 5; }
  ! ss -ltn 2>/dev/null | grep -Eq "127\\.0\\.0\\.1:$port "
}
# run <label> <opencode-model> <sandbox> <cmd> [record] <tasks...>   (record=RECORD puts the proxy in front)
run(){
  local lab=$1 om=$2 sb=$3 cmd=$4 rec=$5; shift 5
  local i SP PP=
  [ $# -gt 0 ] || { say "$lab: nothing to run"; return 0; }
  release_port 8080 || { say "$lab SKIP: 8080 held"; return 1; }
  release_port 18080 || { say "$lab SKIP: 18080 held"; return 1; }
  say "LAUNCH $lab: $cmd --port 18080 (proxy :8080, tap :18090\${rec:+, $rec})"
  eval "exec $cmd --port 18080" > "$L.$lab" 2>&1 & SP=$!
  for i in $(seq 1 240); do healthy 18080 && break; kill -0 $SP 2>/dev/null || break; sleep 5; done
  mkdir -p "$CB/results/$lab"
  local OUTARG=; [ "$rec" = RECORD ] && OUTARG="--out $CB/results/$lab/requests.jsonl"
  node $CB/tools/record-proxy.js --listen 8080 --upstream 18080 --tap 18090 $OUTARG >> "$L.$lab.proxy" 2>&1 & PP=$!
  sleep 2
  if ! healthy; then
    say "$lab LAUNCH FAILED"; grep -iE "error|out of memory|failed|unknown|invalid" "$L.$lab" | tail -3 >> "$L"
    kill $SP $PP 2>/dev/null; wait $SP 2>/dev/null; release_port 8080; release_port 18080; return 1
  fi
  say "START $lab ($# tasks)"; disk
  flock $LOCK timeout 259200 python3 $CB/harness/run.py --runner opencode --model "llama-local/$om" \\
      --sandbox "$sb" --only "$@" --timeout-s ${Number(q.timeoutS) || 7200} --out "$CB/results/$lab" >> "$L" 2>&1
  if healthy; then say "END $lab (server still alive)"; else say "END $lab -- *** SERVER DIED DURING THIS LEG ***"; fi
  disk
  [ -n "$PP" ] && [ "$rec" = RECORD ] && { kill $PP 2>/dev/null; wait $PP 2>/dev/null; gzip -f "$CB/results/$lab/requests.jsonl" 2>/dev/null; say "   recording: $(du -h "$CB/results/$lab/requests.jsonl.gz" 2>/dev/null | cut -f1)"; }
  [ -n "$PP" ] && { kill $PP 2>/dev/null; wait $PP 2>/dev/null; }
  kill $SP 2>/dev/null; wait $SP 2>/dev/null; release_port 8080; release_port 18080
}`);
    const hasCascade = legs.some((x) => x.cascade != null);
    if (hasCascade) {
        L.push(`# aq_sets torun|failed <set-file> <model_path LIKE> <n_ctx> <result_path LIKE or -> <result_path NOT LIKE or ->
# cascade.py's predicate: a task counts as run / passed at THIS config (model, n_ctx, 2 h cap); a task with no
# scored run counts as failed, so it keeps travelling down the cascade.
aq_sets(){
  python3 $CB/tools/db-rebuild.py > /dev/null 2>&1
  python3 - "$@" <<'PY'
import sqlite3, sys
mode, setf, pat, nctx, inc, exc = sys.argv[1:7]
S = [t for t in open(setf).read().split() if t]
d = sqlite3.connect("${path.join(LOGS, 'bench.sqlite')}")
q = "select task, status from runs where excluded=0 and model_path like ? and n_ctx=? and timeout_s=7200 and task not like '%+bonus'"
a = [pat, int(nctx)]
if inc != "-": q += " and result_path like ?"; a.append(inc)
if exc != "-": q += " and result_path not like ?"; a.append(exc)
ran, passed = set(), set()
for t, s in d.execute(q, a):
    ran.add(t)
    if s in ("pass", "pass*"): passed.add(t)
for t in S:
    if mode == "torun" and t not in ran: print(t)
    if mode == "failed" and t not in passed: print(t)
PY
}
# cstage <k> <label> <opencode-model> <LIKE> <n_ctx> <inc> <exc> <cmd> <approved tasks...>: run the approved tasks
# the previous stage failed (and this config has not run), then write this stage's failures for the next one
cstage(){
  local k=$1 lab=$2 om=$3 pat=$4 nctx=$5 inc=$6 exc=$7 cmd=$8; shift 8
  local prev=$T/aq${n}-cascade-$(( k - 1 )).txt
  mapfile -t R < <(aq_sets torun "$prev" "$pat" "$nctx" "$inc" "$exc" | grep -Fx -f <(printf '%s\\n' "$@"))
  say "cascade $k $lab: input $(grep -c . "$prev"), approved $#, to run \${#R[@]}"
  run "$lab" "$om" /tmp/codebench-$lab "$cmd" - "\${R[@]}"
  aq_sets failed "$prev" "$pat" "$nctx" "$inc" "$exc" > $T/aq${n}-cascade-$k.txt
  say "cascade $k $lab: failed $(grep -c . $T/aq${n}-cascade-$k.txt) -> next stage"
}`);
    }
    L.push('');
    if (waitFor) {
        L.push(`say "=== queue${n}: waiting for queue${waitFor} ==="`);
        L.push(`until grep -q "QUEUE${waitFor} DONE" $T/queue${waitFor}.log 2>/dev/null; do sleep 30; done`);
    } else L.push(`say "=== queue${n}: start ==="`);
    L.push('release_port 8080 || say "WARNING: 8080 held at start"');
    // $STOCK / $D27MTP / $Q4 as the queue runner defines them (VARS_FILE): no binary, device id or placement is
    // written here. Until 2026-10-13 this script carried its own copy of the two-card recipe (-dev ROCm0,CUDA0
    // -ts 3,1), which went on describing a card pair after the variables file had moved to another one.
    const v = vars || require('./queue').parseEnvFile(VARS_FILE);
    for (const k of ['STOCK', 'MOE', 'D27MTP', 'Q4']) L.push(v[k] ? `${k}=${/\s/.test(v[k]) ? JSON.stringify(v[k]) : v[k]}` : `# $${k} is not defined in ${VARS_FILE}`);
    L.push('source $T/flash-tuned.env');
    if (hasCascade) {
        const seed = (batch.cascade && batch.cascade.seed) || [];
        seed.forEach(safeTask);
        L.push(`# cascade seed: the tasks the first stage (${(batch.cascade && batch.cascade.order && batch.cascade.order[0]) || '?'}) failed`);
        L.push(`printf '%s\\n' ${seed.join(' ')} > $T/aq${n}-cascade-0.txt`);
    }
    // cascade stages must run in order and every stage in between must propagate its failures
    const order = (batch.cascade && batch.cascade.order) || [];
    const stageLegs = new Map(legs.filter((x) => x.cascade != null).map((x) => [x.cascade, x]));
    const maxStage = Math.max(0, ...stageLegs.keys());
    const emitted = new Set();
    const emitLeg = (leg, i) => {
        const m = byId.get(leg.model);
        if (!m) throw new Error(`unknown model ${leg.model}`);
        if (!m.cmd || !m.opencodeModel) throw new Error(`${m.id} has no launch command / opencode model`);
        const tasks = leg.runs.map((r) => safeTask(r.task));
        const lab = `aq${n}-${m.id}${leg.cascade != null ? `-c${leg.cascade}` : ''}-${i + 1}`;
        if (leg.cascade != null) {
            L.push(`cstage ${leg.cascade} ${lab} ${m.opencodeModel} ${shq(m.dbLike || '%')} ${m.nCtx || 0} ${shq(m.dbIncludeLike || '-')} ${shq(m.dbExcludeLike || '-')} "${m.cmd}" ${tasks.join(' ')}`);
        } else {
            L.push(`run ${lab} ${m.opencodeModel} /tmp/codebench-${lab} "${m.cmd}" - ${tasks.join(' ')}`);
        }
    };
    legs.forEach((leg, i) => {
        if (leg.cascade != null) {
            if (emitted.has('cascade')) return;
            emitted.add('cascade');
            // all stages 1..maxStage in order: a stage with no approved runs still passes its failures on
            for (let k = 1; k <= maxStage; k++) {
                const sl = stageLegs.get(k);
                if (sl) emitLeg(sl, legs.indexOf(sl));
                else {
                    const m = byId.get(order[k]);
                    if (m && m.dbLike) L.push(`cstage ${k} aq${n}-${m.id}-c${k}-skip ${m.opencodeModel || '-'} ${shq(m.dbLike)} ${m.nCtx || 0} ${shq(m.dbIncludeLike || '-')} ${shq(m.dbExcludeLike || '-')} "true"`);
                    else L.push(`cp $T/aq${n}-cascade-$(( ${k} - 1 )).txt $T/aq${n}-cascade-${k}.txt   # stage ${k} (${order[k] || '?'}) does not run here`);
                }
            }
            return;
        }
        emitLeg(leg, i);
    });
    L.push(`say "=== QUEUE${n} DONE ==="`);
    return L.join('\n') + '\n';
}

/** The cloud lane: a separate battery per model, sequential, parallel to the local queue. */
function generateCloudScript(batch, settings, { n, dir, logDir }) {
    const q = settings.queue || DEFAULT_SETTINGS.queue;
    const byId = new Map((settings.models || []).map((m) => [m.id, m]));
    const legs = (batch.legs || []).filter((L) => L.lane === 'cloud' && L.runs && L.runs.length);
    if (!legs.length) return null;
    const LD = logDir || dir;
    const out = ['#!/bin/bash',
        `# Cloud lane of queue${n}, generated by LL-Dash Auto queue: runs in parallel with the local queue (no ports).`,
        '# Effort and scaffold are always explicit: runs without an effort level cannot be labelled.',
        `L=${LD}/cloud${n}.log`, `CB=${q.codebench}`,
        'export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$HOME/.local/bin:$PATH"',
        'say(){ echo "[$(date +%H:%M)] $*" >> "$L"; }',
        `say "=== cloud${n}: start ==="`, 'cd $CB'];
    legs.forEach((leg, i) => {
        const m = byId.get(leg.model);
        if (!m) throw new Error(`unknown model ${leg.model}`);
        if (m.runner !== 'claude') throw new Error(`${m.id}: only the claude runner is supported in the cloud lane`);
        if (!m.effort) throw new Error(`${m.id} has no effort level: refusing to run it (unlabelled runs were deleted)`);
        if (!/^[\w.-]+$/.test(m.effort) || !/^[\w.-]+$/.test(m.scaffold || 'solo') || !/^[\w.-]+$/.test(m.claudeModel || '')) throw new Error(`${m.id}: bad effort / scaffold / model`);
        const lab = `aq${n}-${m.id}-${i + 1}`;
        const tasks = leg.runs.map((r) => safeTask(r.task));
        out.push(`say "START ${lab} (${tasks.length} tasks)"`);
        out.push(`CODEBENCH_CLAUDE_EFFORT=${m.effort} CODEBENCH_CLAUDE_SCAFFOLD=${m.scaffold || 'solo'} timeout 259200 python3 harness/run.py --runner claude --model ${m.claudeModel} \\\n    --sandbox /tmp/codebench-${lab} --only ${tasks.join(' ')} --timeout-s ${Number(q.timeoutS) || 7200} --out results/${lab} >> "$L" 2>&1`);
        out.push(`say "END ${lab}"`);
    });
    out.push(`say "=== CLOUD${n} DONE ==="`);
    return out.join('\n') + '\n';
}

/**
 * enqueue({batch, dryRun, confirm, outDir}) -> {n, waitFor, chain, files, scripts, started, items, dropped}
 * dryRun (the default) writes the equivalent queue scripts to outDir (or logs/autoqueue-dryrun/) as a preview
 * and starts nothing. The real path needs dryRun:false AND confirm:true and INSERTS queue rows (lib/queue.js);
 * the queue runner picks them up. It writes no script and starts no process.
 * Both paths first drop the runs a config already scored (lib/queue.js dropScored: one run per task per config,
 * unless a run is marked rerun or the batch says rerunScored), and say which in `dropped`.
 */
function enqueue({ batch: batchIn, dryRun = true, confirm = false, outDir = null } = {}, deps = {}) {
    if (!batchIn || !Array.isArray(batchIn.legs) || !batchIn.legs.length) throw new Error('empty batch');
    // the focus set's prompt-level configs (`<id>.L3`) are configs the queue must be able to look up
    const settings = plannerSettings(deps.settings || loadSettings());
    const qdir = (settings.queue && settings.queue.dir) || DEFAULT_QUEUE_DIR;
    const chain = detectChain(qdir, deps.psArgs);
    const real = dryRun === false;
    if (real && confirm !== true) throw new Error('a real enqueue needs confirm:true');
    const avail = availability(settings);
    for (const L of batchIn.legs) {
        const a = avail[L.model];
        if (!a) throw new Error(`unknown model ${L.model}`);
        if (!a.ok) throw new Error(`${L.model} ${a.reason}`);
    }
    const q = deps.queue || QUEUE;
    if (real && !q) throw new Error('the queue database is not available: nothing enqueued');
    const mfl = plannerModelForLeg(qdir);
    const guarded = q && typeof q.dropScored === 'function' ? q.dropScored(batchIn, settings, { modelForLeg: mfl }) : { batch: batchIn, dropped: [], queued: [] };
    const dropped = guarded.dropped;
    const queuedDup = guarded.queued || [];
    // UNFINISHED at the config (2026-10-19): the task waits for a continuation of its saved session, not a fresh run
    const pendingContinuation = guarded.pendingContinuation || [];
    const batch = { ...guarded.batch, legs: guarded.batch.legs.filter((L) => L.runs && L.runs.length) };
    if (!batch.legs.length) {
        if (pendingContinuation.length && !dropped.length && !queuedDup.length) throw new Error(`nothing to enqueue: every run in the batch is unfinished at its config and waits for a continuation of its saved session (${pendingContinuation.map((d) => `${d.model} ${d.task}`).join(', ')})`);
        if (dropped.length) throw new Error(`nothing to enqueue: every run in the batch already ran at its config (${dropped.map((d) => `${d.model} ${d.task}`).join(', ')}); tick "include re-runs" to run them again`);
        throw new Error(queuedDup.length ? `nothing to enqueue: every run in the batch is already queued at its config (${queuedDup.map((d) => `${d.model} ${d.task}`).join(', ')})` : 'empty batch');
    }
    const n = chain.next;
    if (real) {
        const items = q.insertBatch(batch, settings, { actor: deps.actor || 'planner', modelForLeg: mfl });
        const list = readJson(BATCHES_FILE, []) || [];
        list.push({ n: null, at: Date.now(), items: items.map((r) => r.id), strategy: batch.strategy || null,
            legs: batch.legs.map((L) => ({ model: L.model, lane: L.lane || 'local', cascade: L.cascade ?? null, tasks: L.runs.map((r) => r.task) })),
            totals: batch.totals || null });
        writeJsonAtomic(BATCHES_FILE, list);
        return { n: null, dryRun: false, items: items.map((r) => ({ id: r.id, lane: r.lane, kind: r.kind, label: r.label, status: r.status, tasks: r.tasks || null })), started: false, queued: true, dropped, alreadyQueued: queuedDup, pendingContinuation,
            held: items.filter((r) => r.status === 'paused').map((r) => r.id) };
    }
    const dir = outDir || DRYRUN_DIR;
    fs.mkdirSync(dir, { recursive: true });
    // the script's own paths ($T: cascade.py's files, flash-tuned.env, the log) stay in the queue dir even
    // in a dry run, so the preview is the script that WOULD run
    const hasLocal = batch.legs.some((L) => (L.lane || 'local') === 'local' && L.runs.length);
    const qs = hasLocal ? generateQueueScript(batch, settings, { n, waitFor: chain.waitFor, dir: qdir }) : null;
    const cs = generateCloudScript(batch, settings, { n, dir: qdir });
    const files = {};
    if (qs) { files.queue = path.join(dir, `queue${n}.sh`); fs.writeFileSync(files.queue, qs, { mode: 0o755 }); }
    if (cs) { files.cloud = path.join(dir, `cloud${n}.sh`); fs.writeFileSync(files.cloud, cs, { mode: 0o755 }); }
    return { n, waitFor: chain.waitFor, chain, dryRun: true, dir, files, scripts: { queue: qs, cloud: cs }, started: false, dropped, alreadyQueued: queuedDup, pendingContinuation };
}

/** Enqueued batches with a state read off their logs. */
function listBatches(deps = {}) {
    const settings = deps.settings || loadSettings();
    const qdir = (settings.queue && settings.queue.dir) || DEFAULT_QUEUE_DIR;
    const args = deps.psArgs || processArgs();
    const list = readJson(BATCHES_FILE, []) || [];
    const stateOf = (file, tag, n) => {
        let log = ''; try { log = fs.readFileSync(path.join(qdir, `${tag}${n}.log`), 'utf-8'); } catch { /* not started */ }
        const done = new RegExp(`${tag.toUpperCase()}${n} DONE`).test(log);
        const alive = args.some((a) => a.includes(`${tag}${n}.sh`));
        const starts = (log.match(/\] START /g) || []).length;
        const state = done ? 'done' : !alive ? (log ? 'stopped' : 'not started') : (/waiting for/.test(log) && !starts ? 'waiting' : 'running');
        return { state, starts, last: log.trim().split('\n').slice(-1)[0] || '' };
    };
    const q = deps.queue || QUEUE;
    const rowState = (ids) => {
        // a batch enqueued as queue rows: its state is its rows' statuses
        const c = {}; let last = '';
        for (const id of ids) { let r = null; try { r = q ? q.get(id) : null; } catch { r = null; } const s2 = r ? r.status : 'deleted'; c[s2] = (c[s2] || 0) + 1; if (r && r.status === 'running') last = `running: ${r.label}`; }
        const state = c.running ? 'running' : (c.pending || c.paused) ? 'queued' : 'done';
        return { state, counts: c, last: last || Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ') };
    };
    return list.map((b) => (Array.isArray(b.items) ? { ...b, queueState: rowState(b.items), cloudState: null }
        : { ...b, queueState: b.files && b.files.queue ? stateOf(b.files.queue, 'queue', b.n) : null,
            cloudState: b.files && b.files.cloud ? stateOf(b.files.cloud, 'cloud', b.n) : null })).reverse();
}


// ------------------------------------------------------------------ pending runs of live queues
// What a running or waiting queue is still going to run, so the planner never proposes it twice.
// Understands queue15.sh's forms and this module's own: `run <lab> <om> <sb> "<cmd>" <rec> tasks...`,
// queue15's `stage <n> <lab> <om> <LIKE> <n_ctx> "<cmd>" [ex]` (its input = the newest existing
// cascade-<k>-*.txt for k < n: an over-estimate until the earlier stage finishes, which is the safe side)
// and `cstage <k> <lab> ... tasks...` (approved list). A leg whose END / "nothing to run" / SKIP /
// LAUNCH FAILED line is in the log is finished. `${ARR[@]}` task lists are not expanded.
function flashEnvBasenames(dir) {
    const out = {};
    let env = ''; try { env = fs.readFileSync(path.join(dir, 'flash-tuned.env'), 'utf-8'); } catch { return out; }
    for (const m of env.matchAll(/^(FLASH_\w+_CMD)="[^"]*?-m\s+(\S+\.gguf)/gm)) out[m[1]] = path.basename(m[2]);
    return out;
}
function modelForLeg(models, om, cmd, flashEnv) {
    let c = String(cmd || '');
    for (const [v, base] of Object.entries(flashEnv)) c = c.replace(new RegExp(`\\$\\{?${v}\\}?`, 'g'), ` -m ${base} `);
    c = c.replace(/\$\{?Q4\}?(?!\w)/g, path.basename(Q4));
    const nothink = /--reasoning off/.test(c);
    const local = models.filter((m) => (m.lane || (m.runner === 'claude' ? 'cloud' : 'local')) === 'local' && m.weights);
    const hits = local.filter((m) => c.includes(path.basename(m.weights)) && /--reasoning off/.test(m.cmd || '') === nothink);
    return hits.find((m) => m.opencodeModel === om) || hits[0] || null;
}
function splitArgs(str) {
    const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
    while ((m = re.exec(str))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
    return out;
}
/** The planner's match of a queue row to a config: the exact launch it wrote, else the weights file (modelForLeg). */
function plannerModelForLeg(qdir = DEFAULT_QUEUE_DIR) {
    const flashEnv = flashEnvBasenames(qdir);
    return (ms, om, cmd) => ms.find((m) => m.opencodeModel === om && m.cmd === cmd) || modelForLeg(ms, om, cmd, flashEnv);
}
function pendingRuns(settingsIn, deps = {}) {
    const settings = plannerSettings(settingsIn);
    const qdir = (settings.queue && settings.queue.dir) || DEFAULT_QUEUE_DIR;
    const args = deps.psArgs || processArgs();
    const models = settings.models || [];
    const flashEnv = flashEnvBasenames(qdir);
    let names = []; try { names = fs.readdirSync(qdir); } catch { /* none */ }
    const queues = [];
    const byModel = {};
    const add = (id, tasks) => { const s2 = byModel[id] || (byModel[id] = new Set()); for (const t of tasks) s2.add(t); };
    for (const f of names) {
        const mm = /^(queue|cloud)(\d+)\.sh$/.exec(f); if (!mm) continue;
        const tag = mm[1], n = Number(mm[2]);
        let log = ''; try { log = fs.readFileSync(path.join(qdir, `${tag}${n}.log`), 'utf-8'); } catch { /* not started */ }
        if (new RegExp(`${tag.toUpperCase()}${n} DONE`).test(log)) continue;
        const alive = args.some((a) => new RegExp(`(^|/|\\s)${tag}${n}\\.sh(\\s|$)`).test(a));
        if (!alive) continue;
        let src = ''; try { src = fs.readFileSync(path.join(qdir, f), 'utf-8'); } catch { continue; }
        const lines = src.replace(/\\\n\s*/g, ' ').split('\n');
        const legsOut = [];
        const finished = (lab) => new RegExp(`(END ${lab}\\b|${lab}: nothing to run|${lab} SKIP|${lab} LAUNCH FAILED)`).test(log);
        for (const line of lines) {
            let m;
            if ((m = /^run\s+(.*)$/.exec(line))) {
                const a = splitArgs(m[1]); const [lab, om, , cmd, , ...tasks] = a;
                if (!lab || finished(lab)) continue;
                const md = modelForLeg(models, om, cmd, flashEnv);
                const tl = tasks.filter((t) => /^[\w.-]+$/.test(t));
                legsOut.push({ lab, model: md ? md.id : null, om, tasks: tl, kind: 'run' });
                if (md) add(md.id, tl);
            } else if ((m = /^stage\s+(.*)$/.exec(line))) {
                const [k, lab, om, , , cmd] = splitArgs(m[1]);
                const kn = Number(k);
                if (!lab || finished(lab) || names.some((x) => x.startsWith(`cascade-${kn}-`))) continue;
                let input = null;
                for (let j = kn - 1; j >= 0 && !input; j--) { const fn = names.find((x) => x.startsWith(`cascade-${j}-`) && x.endsWith('.txt')); if (fn) input = fn; }
                let tl = []; try { tl = input ? fs.readFileSync(path.join(qdir, input), 'utf-8').split(/\s+/).filter((t) => /^[\w.-]+$/.test(t)) : []; } catch { /* none */ }
                const md = modelForLeg(models, om, cmd, flashEnv);
                legsOut.push({ lab, model: md ? md.id : null, om, tasks: tl, kind: `cascade stage ${kn}`, from: input });
                if (md) add(md.id, tl);
            } else if ((m = /^cstage\s+(.*)$/.exec(line))) {
                const [k, lab, om, , , , , cmd, ...tasks] = splitArgs(m[1]);
                if (!lab || finished(lab) || names.includes(`aq${n}-cascade-${k}.txt`)) continue;
                const md = modelForLeg(models, om, cmd, flashEnv);
                const tl = tasks.filter((t) => /^[\w.-]+$/.test(t));
                legsOut.push({ lab, model: md ? md.id : null, om, tasks: tl, kind: `cascade stage ${k}` });
                if (md) add(md.id, tl);
            } else if (tag === 'cloud' && (m = /CODEBENCH_CLAUDE_EFFORT=(\S+) CODEBENCH_CLAUDE_SCAFFOLD=(\S+) .*--model (\S+) .*--only (.*?) --timeout-s .*--out results\/(\S+)/.exec(line))) {
                const [, effort, scaffold, cm, only, lab] = m;
                if (new RegExp(`END ${lab}\\b`).test(log)) continue;
                const md = models.find((x) => x.runner === 'claude' && x.effort === effort && (x.scaffold || 'solo') === scaffold && x.claudeModel === cm);
                const tl = only.split(/\s+/).filter((t) => /^[\w.-]+$/.test(t));
                legsOut.push({ lab, model: md ? md.id : null, tasks: tl, kind: 'cloud' });
                if (md) add(md.id, tl);
            }
        }
        queues.push({ name: `${tag}${n}`, legs: legsOut });
    }
    // the database queue's pending / running rows (lib/queue.js): never re-proposed either
    const q = deps.queue || QUEUE;
    if (q) {
        try {
            const p = q.pendingForPlanner(settings, plannerModelForLeg(qdir));   // rows the planner wrote carry its cmd verbatim; the identity decides between a config's prompt levels
            if (p.queue.legs.length) queues.push(p.queue);
            for (const [id, tasks] of Object.entries(p.byModel)) add(id, tasks);
        } catch (err) { queues.push({ name: 'queue (db)', legs: [], error: err.message }); }
    }
    return { queues, byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, [...v]])) };
}

// ------------------------------------------------------------------ continuous refill (opt-in, 2026-10-15)
// Kyle: "an auto-queue that lets us select which models we want to focus on, and then interpolates test runs for the models
// to keep their information/completion rate roughly comparable as it works through tests for them". With `refill.enabled`
// and a lane in `refill.lanes`, the server (server4.js, a 60 s timer) runs refill() every `intervalMin`: a lane whose
// PENDING PLANNER ROWS (created_by planner, pending or running; held rows do not count) estimate under `minHours` gets the
// planner's next `topUpHours` for the focus configs on that lane, as interleaved chunks. The planner is the browser's own
// (ui/shared/planner.js + ui/autoqueue/derive.js, imported as ES modules), on the same folded catalog, so the dry run and
// the Auto queue page agree. Guards: paused lanes are skipped; cloud is never refilled (no cloud config gets candidates and
// a cloud leg aborts the lane); insertBatch drops what the config already scored AND what is already queued at its identity.
const UI_DIR = path.join(__dirname, '..', 'ui');
let uiMods = null;
function plannerModules() {
    if (!uiMods) {
        const { pathToFileURL } = require('url');
        const imp = (rel) => import(pathToFileURL(path.join(UI_DIR, rel)).href);
        uiMods = Promise.all([imp('shared/planner.js'), imp('autoqueue/derive.js')]).then(([planner, derive]) => ({ ...planner, ...derive }))
            .catch((err) => { uiMods = null; throw err; });
    }
    return uiMods;
}
const FALLBACK_TASK_H = 40 / 60;   // an active planner row with no estimate: 40 min a task left
/** Hours of planner work still ahead on `lane` (pending + running rows the planner made; held rows do not run). */
function plannerHours(active, lane) {
    let h = 0;
    for (const it of active || []) {
        if (it.lane !== lane || it.created_by !== 'planner' || !['pending', 'running'].includes(it.status)) continue;
        if (it.est && Number.isFinite(Number(it.est.hours))) h += Number(it.est.hours);
        else h += ((Array.isArray(it.tasks) ? it.tasks.length : 1) || 1) * FALLBACK_TASK_H;
    }
    return Math.round(h * 100) / 100;
}
/**
 * The refill decision for every lane the focus set uses (and every lane in refill.lanes), PURE but for the planner modules:
 * deps = { settings, catalog (raw /api/models/catalog object), lanes: [{lane, paused}], active: queue rows (pending /
 * paused / running, with est), availability, pending: {model: [task]}, promptTasks, mods (plannerModules()) }.
 * -> { at, enabled, focus, lanes: [{ lane, refill (in refill.lanes), paused, plannerHours, minHours, action ('fill' | 'skip'),
 *      reason, coverage, chunks: [{model, label, chunk, chunks, tasks, minutes}], batch }] }
 */
function planRefill(deps) {
    const settings = plannerSettings(deps.settings);
    const R = { ...DEFAULT_SETTINGS.refill, ...(settings.refill || {}) };
    const mods = deps.mods;
    const out = { at: new Date(deps.now || Date.now()).toISOString(), enabled: !!R.enabled, focus: settings.focusIds, lanes: [] };
    if (!settings.focusIds.length) { out.note = 'no focus set: refill only plans for the focus configs'; return out; }
    const derived = mods.derive(mods.plannerCatalog(deps.catalog), settings, deps.availability || {}, deps.pending || {}, deps.promptTasks || {});
    const byId = new Map(derived.input.models.map((m) => [m.id, m]));
    const focusLane = new Map(settings.focusIds.filter((id) => byId.has(id)).map((id) => [id, byId.get(id).queueLane]));
    const laneNames = [...new Set([...R.lanes, ...focusLane.values()])];
    for (const lane of laneNames) {
        const rec = { lane, refill: R.lanes.includes(lane), paused: false, plannerHours: plannerHours(deps.active, lane), minHours: R.minHours,
            topUpHours: R.topUpHours, action: 'skip', reason: '', configs: [...focusLane].filter(([, l]) => l === lane).map(([id]) => id), coverage: [], chunks: [], batch: null };
        out.lanes.push(rec);
        const L = (deps.lanes || []).find((x) => x.lane === lane);
        rec.paused = !!(L && L.paused);
        if (lane === 'cloud') { rec.reason = 'cloud is never refilled (cloud runs need Kyle\'s OK)'; continue; }
        if (rec.paused) { rec.reason = `lane paused${L.note ? `: ${L.note}` : ''}`; continue; }
        if (!rec.configs.length) { rec.reason = 'no focus config runs on this lane'; continue; }
        if (rec.plannerHours >= R.minHours) { rec.reason = `topped up: ${rec.plannerHours} h of planner work queued (refill below ${R.minHours} h)`; continue; }
        const s2 = { ...settings, strategy: 'greedy', pins: [], onlyQueueLane: lane,
            budget: { ...(settings.budget || {}), localHours: R.topUpHours, cloud: false, cloudHours: 0 } };
        const p = mods.plan(derived.input, s2);
        const legs = p.legs.filter((x) => x.lane !== 'cloud' && x.cascade == null && (x.queueLane || 'local-gpu') === lane);
        if (p.legs.some((x) => x.lane === 'cloud')) throw new Error('refill planned a cloud run: refusing (cloud runs need Kyle\'s OK)');
        const chunks = mods.chunkSchedule(legs, settings.chunkTasks);
        rec.coverage = p.coverage;   // every focus config: the lane's plan is balanced against the whole set
        // the dry run's "why": per run its predicted pass p, information I, expected minutes and score (rec.batch keeps {task})
        const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
        rec.scoring = p.scoring || 'legacy';
        rec.chunks = chunks.map((c) => ({ model: c.model, label: c.label, chunk: c.chunk, chunks: c.chunks, tasks: c.runs.map((r) => r.task), minutes: Math.round(c.minutes || 0),
            runs: c.runs.map((r) => ({ task: r.task, p: r3(r.p), I: r3(r.I), info: r3(r.info), minutes: Math.round(r.minutes || 0), score: r.score != null ? Math.round(r.score * 1e5) / 1e5 : null, points: r3(r.points) })) }));
        // and each config's best first-round candidates (picked or not), so the alternatives can be read off too
        rec.candidates = p.candidates ? Object.fromEntries(Object.entries(p.candidates).map(([id, c]) => [id, { label: c.label, theta: r3(c.theta), se: r3(c.se), n: c.n,
            top: c.top.map((x) => ({ task: x.task, p: r3(x.p), I: r3(x.I), info: r3(x.info), minutes: Math.round(x.minutes || 0), score: Math.round(x.score * 1e5) / 1e5, belowFloor: x.belowFloor || undefined })) }])) : null;
        rec.batch = chunks.length ? { strategy: 'greedy', source: 'refill', plannedAt: out.at, legs: chunks.map((c) => ({ model: c.model, lane: 'local', chunk: c.chunk, chunks: c.chunks, runs: c.runs.map((r) => ({ task: r.task })) })) } : null;
        rec.action = chunks.length ? 'fill' : 'skip';
        rec.reason = chunks.length ? `${rec.plannerHours} h of planner work queued, under ${R.minHours} h: ${chunks.length} chunk(s), ~${Math.round(chunks.reduce((a, c) => a + (c.minutes || 0), 0) / 6) / 10} h`
            : 'nothing worth running for the focus configs on this lane';
    }
    return out;
}
/**
 * refill({dryRun}) -> planRefill's answer, with what the queue's guard would drop (`dropped` already ran, `alreadyQueued`) and,
 * when real, `inserted` per lane. Real inserts need dryRun:false AND refill.enabled AND the lane in refill.lanes. deps: queue,
 * settings, catalog: async () => the raw catalog, psArgs.
 */
async function refill({ dryRun = true } = {}, deps = {}) {
    const q = deps.queue || QUEUE;
    if (!q) throw new Error('the queue database is not available');
    if (typeof deps.catalog !== 'function') throw new Error('no catalog');
    const settings = deps.settings || loadSettings();
    const ps = plannerSettings(settings);
    const [catalog, mods] = await Promise.all([deps.catalog(), deps.mods || plannerModules()]);
    const L = q.list({ history: 1 });
    const pend = pendingRuns(settings, { queue: q, psArgs: deps.psArgs });
    const res = planRefill({ settings, catalog, lanes: L.lanes, active: [...L.running, ...L.pending], availability: availability(settings),
        pending: pend.byModel, promptTasks: deps.promptTasks || promptTasksFor(settings), mods });
    res.dryRun = dryRun !== false;
    const mfl = plannerModelForLeg((settings.queue && settings.queue.dir) || DEFAULT_QUEUE_DIR);
    for (const rec of res.lanes) {
        if (!rec.batch) continue;
        const g = q.dropScored(rec.batch, ps, { modelForLeg: mfl });
        rec.dropped = g.dropped; rec.alreadyQueued = g.queued || []; rec.pendingContinuation = g.pendingContinuation || [];
        rec.batch = { ...g.batch, legs: g.batch.legs.filter((x) => x.runs && x.runs.length) };
        if (!rec.batch.legs.length) { rec.action = 'skip'; rec.reason = 'every planned run already ran, is already queued, or waits for a continuation'; rec.batch = null; continue; }
        if (rec.batch.legs.some((x) => x.lane === 'cloud' || (ps.models.find((m) => m.id === x.model) || {}).lane === 'cloud')) throw new Error('refill batch has a cloud leg: refusing');
        if (res.dryRun || !res.enabled || !rec.refill || rec.paused) continue;
        const items = q.insertBatch(rec.batch, ps, { actor: 'refill', modelForLeg: mfl });
        rec.inserted = items.map((r) => ({ id: r.id, lane: r.lane, label: r.label, tasks: r.tasks || null }));
        const list = readJson(BATCHES_FILE, []) || [];
        list.push({ n: null, at: Date.now(), items: items.map((r) => r.id), strategy: 'greedy', source: 'refill', lane: rec.lane,
            legs: rec.batch.legs.map((x) => ({ model: x.model, lane: 'local', cascade: null, tasks: x.runs.map((r) => r.task) })) });
        writeJsonAtomic(BATCHES_FILE, list);
    }
    return res;
}
// ------------------------------------------------------------------ lane floor (2026-10-21)
// Kyle 10-21, after ROCm1 sat empty 7 h behind three launch failures: "lanes should never be sitting empty ... empty lanes
// should get populated and not waste time". The refill above only counts PLANNER rows and plans for a focus set; the floor
// counts EVERY item on a lane and fills it with the rule Kyle gave the same day: a row's gaps against the reference row
// (27B Q8_K_XL 131k), hardest first. Strength, difficulty and "which problems a row has run" all come from the ONE fit,
// ui/shared/leaderboard.js (the Models page's default view); "already ran / already queued at this config" from the ONE
// identity, lib/configid through the queue's draftGuard. Nothing here ranks or keys anything itself.
let lbMod = null;
function leaderboardModule() {
    if (!lbMod) {
        const { pathToFileURL } = require('url');
        lbMod = import(pathToFileURL(path.join(UI_DIR, 'shared/leaderboard.js')).href).catch((err) => { lbMod = null; throw err; });
    }
    return lbMod;
}
let neverWhy = () => null;              // planFloor sets it from floor.never
const FLOOR_TASK_H = 40 / 60;          // an active item without an estimate counts 40 min a task (plannerHours' fallback)
const BACKLOG_TAG = /^\s*\[backlog\]/i;   // the tag must OPEN the notes: "no [backlog] tag" inside them is not one (10-06)
const LAUNCH_FAILED = /LAUNCH FAILED/i;
const BACKBURNER = /BACKBURNER/i;        // Kyle's word for "not now": an item or template saying so is never released or copied
/** An item's env for a floor row of `level` / composite: the template's own env, without what belongs to ITS run (level,
 *  continuation, rerun permission, the composite tool switch), under the planner's docs-off pin. */
function floorEnv(env, { level = 'L2', composite = false } = {}) {
    const out = { ...(env || {}) };
    for (const k of ['CODEBENCH_PROMPT_LEVEL', 'CODEBENCH_CONTINUE_FROM', 'CODEBENCH_CONTINUE_ONCE', 'CODEBENCH_ALLOW_RERUN', 'OPENCODE_CONFIG_CONTENT']) delete out[k];
    if (level !== 'L2') out.CODEBENCH_PROMPT_LEVEL = level;
    // composites run with the task tool off, as every composite row since 10-18 (1105, 1217, 1229, 1230)
    if (composite) out.OPENCODE_CONFIG_CONTENT = JSON.stringify({ tools: { task: false }, permission: { task: 'deny' } });
    out.CODEBENCH_DOCS = 'off';
    return out;
}
/** Hours of work on `lane`: every pending + running item (held ones do not run), by the queue's estimate. */
function laneHours(active, lane) {
    let h = 0;
    for (const it of active || []) {
        if (it.lane !== lane || !['pending', 'running'].includes(it.status)) continue;
        if (it.est && Number.isFinite(Number(it.est.hours))) h += Number(it.est.hours);
        else h += ((Array.isArray(it.tasks) ? it.tasks.length : 1) || 1) * FLOOR_TASK_H;
    }
    return Math.round(h * 100) / 100;
}
/** The fit group (Models page row) a config's runs are filed in: the group holding most of the battery dirs its identity
 *  scored (any level). Null when it has none yet. */
function floorGroup(fit, dirs) {
    let best = null; let hits = 0;
    for (const g of fit.qAll) {
        const n = (g.dirs || []).filter((d) => dirs.has(d)).length;
        if (n > hits || (n === hits && n > 0 && best && (g.q.scored || 0) > (best.q.scored || 0))) { best = g; hits = n; }
    }
    return best;
}
/** Problems (problem ids) a group has a SCORED result for: tried, not excluded, not a +bonus entry. */
function scoredProblems(g) {
    const out = new Set();
    for (const [p, t] of Object.entries((g && g.tasks) || {})) if (t && t.attempts && !t.excluded && !/\+bonus$/.test(p)) out.add(p);
    return out;
}
/**
 * The floor's decision for every configured lane. deps: { settings, queue, catalog (raw catalog object), L (leaderboard
 * module), now }. -> { at, enabled, lanes: [{ lane, paused, hours, floor, action ('none' | 'release' | 'fill' | 'stuck'),
 * reason, release, config, items: [{fields, est, hardest}] , skipped: [{config, reason}] }] }. Pure but for reading the queue.
 */
function planFloor(deps) {
    const settings = deps.settings || loadSettings();
    const F = { ...DEFAULT_SETTINGS.floor, ...(settings.floor || {}) };
    const q = deps.queue;
    const out = { at: new Date(deps.now || Date.now()).toISOString(), enabled: !!F.enabled, floorHours: F.hours, lanes: [] };
    const L = q.list({ history: 1 });
    const active = [...L.running, ...L.pending];
    const laneInfo = new Map((L.lanes || []).map((x) => [x.lane, x]));
    let fitCache = null;
    const fitOf = () => {
        if (fitCache) return fitCache;
        const lb = deps.L;
        const v = lb.overviewView({ store: { getItem: () => null } });
        const shown = lb.overviewCatalog(deps.catalog, v);
        fitCache = { lb, fit: lb.fitFor(shown.models, v.keepQ, v.keepT), meta: deps.catalog.taskMeta || {} };
        return fitCache;
    };
    const dirsOf = (fields) => {   // every battery dir the config's identity has a scored run in, L2 and L3 alike
        const dirs = new Set();
        for (const level of ['L2', 'L3']) for (const d of q.draftDirs({ ...fields, env: floorEnv(fields.env, { level }) })) dirs.add(d);
        return dirs;
    };
    const templateOf = (id) => {
        const r = q.get(Number(id));
        if (!r || r.kind !== 'run' || !r.launch_cmd) return null;
        return { lane: r.lane, runner: r.runner || 'opencode', model: r.model, launch_cmd: r.launch_cmd, timeout_s: Number(r.timeout_s) || 7200, env: r.env || {}, label: r.label, notes: r.notes || '' };
    };
    const never = (Array.isArray(F.never) ? F.never : []).filter((n) => n && n.pattern);
    neverWhy = (cmd, lane) => {
        const n = never.find((x) => String(cmd || '').includes(String(x.pattern)) && (!Array.isArray(x.lanes) || !x.lanes.length || x.lanes.includes(lane)));
        return n ? (n.why || `matches ${n.pattern}`) : null;
    };
    for (const [lane, configs] of Object.entries(F.lanes || {})) {
        const info = laneInfo.get(lane) || {};
        const rec = { lane, paused: !!info.paused, hours: laneHours(active, lane), floor: F.hours, action: 'none', reason: '', skipped: [], items: [] };
        out.lanes.push(rec);
        if (lane === 'cloud') { rec.reason = 'the floor never fills the cloud lane'; continue; }
        if (rec.paused) { rec.reason = `lane paused${info.note ? `: ${info.note}` : ''}`; continue; }
        if (rec.hours >= F.hours) { rec.reason = `${rec.hours} h queued (floor ${F.hours} h)`; continue; }
        // (a) the oldest held item of this lane tagged [backlog]
        const back = (L.pending || []).filter((it) => it.lane === lane && it.status === 'paused' && BACKLOG_TAG.test(it.notes || '') && !BACKBURNER.test(it.notes || '') && !neverWhy(it.launch_cmd, lane))
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id)[0];
        if (back) { rec.action = 'release'; rec.release = { id: back.id, label: back.label }; rec.reason = `${rec.hours} h queued, under ${F.hours} h: release [backlog] item ${back.id}`; continue; }
        // (b) the configs' gaps against the reference row, strongest config first
        // three launch failures in a row on this lane with one config: that config is not fed again (it says so)
        const last3 = q.lastFinished(lane, 3);
        const failedLaunch = last3.length === 3 && last3.every((r) => r.status === 'failed' && LAUNCH_FAILED.test(String((r.outcome || {}).reason || '')));
        const blockedCmds = failedLaunch ? new Set(last3.map((r) => r.launch_cmd)) : new Set();
        let fc;
        try { fc = fitOf(); } catch (err) { rec.action = 'stuck'; rec.reason = `the Models page fit failed: ${err.message}`; continue; }
        const { lb, fit, meta } = fc;
        const refT = templateOf(F.reference && F.reference.template);
        const refG = refT ? floorGroup(fit, dirsOf(refT)) : null;
        if (!refG) { rec.action = 'stuck'; rec.reason = `the reference row (item ${F.reference && F.reference.template}) has no fit group`; continue; }
        const refP = scoredProblems(refG);
        const diff = fit.adj.taskDifficulty || new Map();
        const cands = [];
        for (const c of configs || []) {
            const t = templateOf(c.template);
            if (!t) { rec.skipped.push({ config: c.id, reason: `template item ${c.template} is not a run item with a launch command` }); continue; }
            if (t.lane !== lane) { rec.skipped.push({ config: c.id, reason: `template item ${c.template} is on ${t.lane}, not ${lane}` }); continue; }
            if (neverWhy(t.launch_cmd, lane)) { rec.skipped.push({ config: c.id, reason: `never fed: ${neverWhy(t.launch_cmd, lane)}` }); continue; }
            if (BACKBURNER.test(t.notes || '')) { rec.skipped.push({ config: c.id, reason: `template item ${c.template} says BACKBURNER` }); continue; }
            if (blockedCmds.has(t.launch_cmd)) { rec.skipped.push({ config: c.id, reason: `the last 3 items on ${lane} failed at launch with this config: not fed again until one of them is looked at` }); continue; }
            const g = floorGroup(fit, dirsOf(t));
            const a = g ? fit.adj.get(g.key) : null;
            cands.push({ c, t, g, rank: lb.strengthRank(a), strength: a ? a.strength : null });
        }
        cands.sort((x, y) => y.rank - x.rank);
        let need = F.topUpHours - rec.hours;
        // tier 1: the reference row's problems; tier 2 (only when tier 1 left the lane short): every problem the fit has a
        // difficulty for (some row has run it) -- first runs of benchmark problems on this lane's configs, as idle-guard did
        const field = new Set([...diff.keys()].filter((p) => !/\+bonus$/.test(p)));
        const tiers = [{ tier: 'reference', set: refP, what: `problem(s) the ${F.reference.label || 'reference'} row has run and this row has not` }];
        if (F.fieldFallback !== false) tiers.push({ tier: 'field', set: field, what: `problem(s) other rows have run and this row has not (the ${F.reference.label || 'reference'} row's are all run or queued)` });
        const taken = new Set();   // config|task already in an earlier tier's row
        for (const T of tiers) {
            for (const cd of cands) {
                if (need <= 0) break;
                const have = scoredProblems(cd.g);
                const gaps = [...T.set].filter((p) => !have.has(p)).map((p) => {
                    const po = lb.problemOf(p);
                    const m = meta[po.base] || null;
                    return { p, task: po.task, base: po.base, level: po.level, d: diff.has(p) ? diff.get(p) : null, m };
                }).filter((x) => x.m && !x.m.unscored && !x.m.diagnostic && !taken.has(`${cd.c.id}|${x.p}`))
                    .sort((x, y) => (y.d ?? -99) - (x.d ?? -99));
                if (!gaps.length) { rec.skipped.push({ config: cd.c.id, tier: T.tier, reason: 'no gaps' }); continue; }
                // per kind (level x composite): drop what this config scored, waits for a continuation, or already has queued
                const kinds = new Map();
                for (const x of gaps) {
                    const composite = x.m.repo === 'multi' || (Array.isArray(x.m.category) && x.m.category.includes('multi'));
                    const k = `${x.level}|${composite ? 'c' : 's'}`;
                    if (!kinds.has(k)) kinds.set(k, { level: x.level, composite, list: [] });
                    kinds.get(k).list.push(x);
                }
                const dropped = { scored: 0, waiting: 0, queued: 0 };
                for (const K of kinds.values()) {
                    K.fields = { lane: cd.t.lane, runner: cd.t.runner, model: cd.t.model, launch_cmd: cd.t.launch_cmd, env: floorEnv(cd.t.env, K), timeout_s: K.composite ? F.compositeTimeoutS : cd.t.timeout_s };
                    const gd = q.draftGuard(K.fields, K.list.map((x) => x.task));
                    if (!gd.key) { K.list = []; rec.skipped.push({ config: cd.c.id, tier: T.tier, reason: `no identity for its ${K.level}${K.composite ? ' composite' : ''} rows: not queued` }); continue; }
                    K.list = K.list.filter((x) => {
                        if (gd.scored.has(x.task)) { dropped.scored++; return false; }
                        if (gd.waiting.has(x.task)) { dropped.waiting++; return false; }
                        if (gd.queued.has(x.task)) { dropped.queued++; return false; }
                        return true;
                    });
                }
                // chunks in the order of their hardest problem; each chunk one kind
                const chunks = [];
                for (const K of kinds.values()) {
                    const size = K.composite ? F.compositeChunk : F.chunkTasks;
                    for (let i = 0; i < K.list.length; i += size) chunks.push({ K, list: K.list.slice(i, i + size) });
                }
                chunks.sort((x, y) => (y.list[0].d ?? -99) - (x.list[0].d ?? -99));
                const before = rec.items.length;
                for (const ch of chunks) {
                    if (need <= 0) break;
                    const tasks = ch.list.map((x) => x.task);
                    const fields = { ...ch.K.fields, tasks };
                    let est = null; try { est = q.estimateDraft(fields); } catch { est = null; }
                    const hours = est && Number.isFinite(est.hours) ? est.hours : tasks.length * FLOOR_TASK_H;
                    const ds = ch.list.map((x) => (x.d == null ? '?' : x.d.toFixed(2)));
                    for (const x of ch.list) taken.add(`${cd.c.id}|${x.p}`);
                    rec.items.push({ config: cd.c.id, label: cd.c.label, template: cd.c.template, tier: T.tier, what: T.what, level: ch.K.level, composite: ch.K.composite, tasks,
                        hours: Math.round(hours * 100) / 100, difficulty: ds, fields });
                    need -= hours;
                }
                if (rec.items.length === before) rec.skipped.push({ config: cd.c.id, tier: T.tier, reason: `every gap (${gaps.length}) is already scored, waiting for a continuation or queued at its config (${JSON.stringify(dropped)})` });
                else (rec.strength || (rec.strength = {}))[`${cd.c.id}/${T.tier}`] = { strength: cd.strength, lowEnd: cd.rank, row: cd.g ? (cd.g.dirs || [])[0] : null, gaps: gaps.length, dropped };
            }
        }
        rec.action = rec.items.length ? 'fill' : (failedLaunch ? 'stuck' : 'none');
        const addH = Math.round(rec.items.reduce((s, x) => s + x.hours, 0) * 10) / 10;
        rec.reason = rec.items.length ? `${rec.hours} h queued, under ${F.hours} h: ${rec.items.length} row(s), ~${addH} h, gaps against the ${F.reference.label || 'reference'} row, hardest first`
            : failedLaunch ? `${rec.hours} h queued and the last 3 items failed at launch: nothing fed (${rec.skipped.map((s) => `${s.config}: ${s.reason}`).join('; ')})`
                : `${rec.hours} h queued, under ${F.hours} h, but nothing to add (${rec.skipped.map((s) => `${s.config}: ${s.reason}`).join('; ') || 'no configs'})`;
    }
    return out;
}
/**
 * floor({dryRun}) -> planFloor's answer; real (dryRun false AND floor.enabled) it releases / inserts. Items: created_by
 * 'planner', at the lane's end, notes starting "[floor]" with why. deps: queue, settings, catalog: async () => raw catalog.
 */
async function floor({ dryRun = true } = {}, deps = {}) {
    const q = deps.queue || QUEUE;
    if (!q) throw new Error('the queue database is not available');
    if (typeof deps.catalog !== 'function') throw new Error('no catalog');
    const settings = deps.settings || loadSettings();
    const F = { ...DEFAULT_SETTINGS.floor, ...(settings.floor || {}) };
    const [catalog, L] = await Promise.all([deps.catalog(), deps.L || leaderboardModule()]);
    const res = planFloor({ settings, queue: q, catalog, L, now: deps.now });
    res.dryRun = dryRun !== false;
    if (res.dryRun || !res.enabled) return res;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12);
    for (const rec of res.lanes) {
        if (rec.action === 'release' && rec.release) {
            q.setStatus(rec.release.id, 'release', { actor: 'floor' });
            rec.released = rec.release.id;
            continue;
        }
        if (rec.action !== 'fill') continue;
        rec.inserted = [];
        rec.items.forEach((x, i) => {
            const label = q.freeLabel(`floor-${x.config}-${x.level.toLowerCase()}${x.composite ? '-comp' : ''}-${stamp}-${i + 1}`);
            const notes = `[floor] ${new Date().toISOString().slice(0, 16)}Z: ${rec.lane} had ${rec.hours} h of work, under the ${F.hours} h floor (Kyle 10-21: "lanes should never be sitting empty"). `
                + `${x.label}: ${x.tasks.length} ${x.what}, hardest first by the Models page fit (difficulty ${x.difficulty.join(', ')}; Kyle 10-21: "match all of the q8 27b runs, passes and fails, starting from hardest"). `
                + `Config copied from item ${x.template}.`;
            const row = q.insert({ ...x.fields, kind: 'run', label, notes }, { actor: 'floor', createdBy: 'planner' });
            rec.inserted.push({ id: row.id, label: row.label, tasks: x.tasks });
        });
    }
    return res;
}
/** The server's timer: every `everyMs` it looks at refill.enabled / intervalMin and runs one real refill at a time, and at
 *  floor.enabled / floor.intervalMin and runs one real floor pass (2026-10-21). -> { stop, last: () => the last refill answer
 *  (or error), lastFloor: () => the last floor answer (or error) }. Both off unless settings say so; neither overlaps itself.
 *  The floor logs what it does, and a lane it cannot fill, once per change of reason (not every pass). */
function startRefillTimer(deps = {}, { everyMs = 60000, log = console.log } = {}) {
    let busy = false, lastAt = 0, last = null;
    let fBusy = false, fLastAt = 0, fLast = null;
    const said = new Map();   // lane -> the last "cannot fill" reason logged
    const tickRefill = async (settings) => {
        const R = { ...DEFAULT_SETTINGS.refill, ...(settings.refill || {}) };
        if (busy || !R.enabled || !R.lanes.length) return;
        if (Date.now() - lastAt < R.intervalMin * 60000) return;
        busy = true; lastAt = Date.now();
        try {
            last = await refill({ dryRun: false }, { ...deps, settings });
            const ins = last.lanes.filter((x) => x.inserted && x.inserted.length);
            if (ins.length) log(`[autoqueue refill] ${ins.map((x) => `${x.lane}: ${x.inserted.length} row(s) (${x.inserted.map((r) => '#' + r.id).join(' ')})`).join('; ')}`);
        } catch (err) { last = { error: err.message, at: new Date().toISOString() }; log(`[autoqueue refill] failed: ${err.message}`); }
        finally { busy = false; }
    };
    const tickFloor = async (settings) => {
        const F = { ...DEFAULT_SETTINGS.floor, ...(settings.floor || {}) };
        if (fBusy || !F.enabled) return;
        if (Date.now() - fLastAt < F.intervalMin * 60000) return;
        fBusy = true; fLastAt = Date.now();
        try {
            fLast = await floor({ dryRun: false }, { ...deps, settings });
            for (const x of fLast.lanes) {
                if (x.inserted && x.inserted.length) { log(`[autoqueue floor] ${x.lane}: ${x.reason} -> ${x.inserted.map((r) => '#' + r.id).join(' ')}`); said.delete(x.lane); continue; }
                if (x.released) { log(`[autoqueue floor] ${x.lane}: ${x.reason} -> released #${x.released}`); said.delete(x.lane); continue; }
                const short = x.action === 'stuck' || (x.action === 'none' && x.hours < x.floor);
                if (short && said.get(x.lane) !== x.reason) { log(`[autoqueue floor] ${x.lane} STAYS SHORT: ${x.reason}`); said.set(x.lane, x.reason); }
                if (!short) said.delete(x.lane);
            }
        } catch (err) { fLast = { error: err.message, at: new Date().toISOString() }; log(`[autoqueue floor] failed: ${err.message}`); }
        finally { fBusy = false; }
    };
    const tick = async () => {
        let settings; try { settings = loadSettings(); } catch { return; }
        await tickRefill(settings);
        await tickFloor(settings);
    };
    const h = setInterval(tick, everyMs);
    if (h.unref) h.unref();
    return { stop: () => clearInterval(h), last: () => last, lastFloor: () => fLast, tick };
}

// ------------------------------------------------------------------ EXPERIMENTS.md -> candidate pins
// Suggested pins for the open items the planner can act on. Everything else is listed without one.
const BACKLOG_PINS = {
    E1: [{ model: 'q27-iq2', tasks: ['@discriminating'] }, { model: 'q27-q2', tasks: ['@discriminating'] }, { model: 'q27-q3', tasks: ['@discriminating'] }, { model: 'q27-q6', tasks: ['@discriminating'] }],
    E1b: [{ model: 'q27-q6', tasks: ['@cascade-bottom'] }],
    E3: [{ model: 'flash-q3', tasks: ['@discriminating'] }],
    G1: [{ model: 'q4-nothink', tasks: ['@discriminating'] }],
    H1: [{ model: 'ornith', tasks: ['@discriminating'] }],
};
function parseExperiments(file = EXPERIMENTS_FILE, sections = ['e', 'g', 'h']) {
    let md = ''; try { md = fs.readFileSync(file, 'utf-8'); } catch { return []; }
    const out = [];
    let sec = null;
    for (const line of md.split('\n')) {
        const h = /^## \((\w+)\)\s*(.*)$/.exec(line);
        if (h) { sec = sections.includes(h[1]) ? { id: h[1], title: h[2] } : null; continue; }
        if (/^## /.test(line)) { sec = null; continue; }
        if (!sec || !/^\|/.test(line)) continue;
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length < 3 || cells[0] === '#' || /^-+$/.test(cells[0])) continue;
        const id = cells[0].replace(/\*/g, '');
        const status = cells[2].replace(/\*/g, '');
        if (/^(done|dropped|rejected)/i.test(status)) continue;
        out.push({ id, section: sec.id, sectionTitle: sec.title, title: cells[1].replace(/\*\*/g, ''), status, notes: (cells[3] || '').replace(/\*\*/g, ''),
            pins: BACKLOG_PINS[id] || [], plannable: !!BACKLOG_PINS[id] });
    }
    return out;
}

module.exports = {
    SETTINGS_FILE, BATCHES_FILE, DEFAULT_SETTINGS, DEFAULT_MODELS, DRYRUN_DIR, QUEUE_LANES,
    loadSettings, saveSettings, availability, withVariantKey, mergeModels, detectChain, pendingRuns, modelForLeg, generateQueueScript, generateCloudScript, enqueue, listBatches, parseExperiments, setQueue,
    expandFocus, plannerSettings, promptLevelTasks, promptTasksFor, plannerModelForLeg, plannerHours, planRefill, refill, startRefillTimer, plannerModules,
    laneHours, floorEnv, planFloor, floor, leaderboardModule, floorGroup,   // floorGroup: also lib/liveodds.js (the live view's odds)
};
