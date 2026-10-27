# LL-Dash API

Contract for the HTTP + SSE surface served by `server4.js` on port 3000.
Two clients consume it today: the browser UI (`index.html`/`script.js`) and
the terminal UI (`llama-cli/`). This document is the source of truth when
adding a third client or changing a payload — update it in the same change.

Base URL: `http://localhost:3000` (the server binds all interfaces).
Auth: none by default (localhost tooling). The one exception is the
**tunnel gate**: while the Cloudflare quick tunnel is running, *every*
request (local or remote) must carry `Authorization: Bearer <password>`
or a valid `mc_session` cookie — see **Remote access (tunnel gate)**
below. The gate is armed/disarmed together with the tunnel and never
persisted.

## GET /api/status — SSE state stream

`Accept: text/event-stream`. Sends one `data: <json>\n\n` frame on every
state transition, log line, and progress event, plus a `: ping` comment
line every 15 s (heartbeat — clients should treat 45 s of silence as a
dead connection).

Frame payload:

```json
{
  "state": "stopped|starting|running|stopping",
  "model": "Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf",
  "isRpc": false,
  "log": "",
  "error": "",
  "loadStartTime": 1787386000000,
  "finalLoadTime": 18432,
  "launchCommand": "/path/to/llama-server -m /path/model.gguf -c 32768 ...",
  "launchConfig": { "modelPath": "...", "build": "vulkan-cuda", "ctx": 32768, "ngl": 99, "port": 8080,
    "devices": [ { "id": "Vulkan1", "name": "AMD Radeon RX 7900 XTX", "share": 50 },
                 { "worker": "laptop", "share": 30 },
                 { "id": "CUDA0", "name": "NVIDIA GeForce RTX 3060", "share": 20 } ],
    "deviceA": "Vulkan1", "deviceB": "CUDA0", "rpcTarget": "laptop", "tensorSplit": 50, "argString": "" }
}
```

`launchConfig` is the structured config of the most recent `/api/start`
(null after stop) — clients can repopulate a config form from it.

**`/api/status?ticks=1`** (2026-10-22) also carries the sidebar's live numbers as NAMED events (the browser's
`onmessage` never sees them; listen with `addEventListener`): `event: telemetry` with every reading the server's
telemetry loop takes (the body of `GET /api/telemetry/latest`), and `event: lanes` every second (the body of
`GET /api/lanes/live`); the newest of each is sent at once on connect. Only on request: a client that reads every
`data:` line as a state frame (dash-cli, lib/sweep.js) must not ask for them. The web UI uses this instead of polling
those two routes, and polls them only while no tick has arrived for 5 s. Between the 1 s `lanes` ticks, a lane's phase
edge (its tap's request / first token / end, or its engine's phase changing) sends the same body at once with
`"edge": true` (2026-10-22); the web UI redraws the Live view's prefill / generation strip on it and leaves the
sidebar's 1 s series alone.

**Devices.** `devices` is the ordered list the model runs on; its order is
the `-dev` and `-ts` order. A local entry is `{ id, name?, share? }` (`id` a
llama.cpp device such as `CUDA0`/`Vulkan1`, `name` the card name). A worker
entry is `{ worker, workerDevice?, share? }`, where `worker` names an
`rpcWorkers` entry (or is an ssh target). Its `RPC<n>` id is assigned from
`--rpc` order and is never sent by clients. `share`s are proportions (`-ts`).
`enabled: false` keeps an entry in a profile without using it. An empty list
emits no device flags (llama-server picks). When a local entry's `name` no
longer matches the card at its `id` (ids shift when a GPU is added or
removed), the server re-points it at the same card and reports a warning.

`deviceA`/`deviceB`/`rpcTarget`/`tensorSplit` are the older two-device
fields. A config without `devices` is converted from them (the CLI still
sends only these; the web UI sends only `devices`). Launch configs and saved
profiles carry both until every client reads `devices`.

`specDraftDevice` (optional) emits `--spec-draft-device <id>`: where the
draft/MTP model runs. It must be a local device id (`CUDA0`, `Vulkan1`, …, not
`RPC<n>`: drafting on a worker would add a network round trip to every draft
step), else `400`.

### Tagged `log` values

Most `log` values are raw `llama-server` output lines (echoed for display).
Some are tagged events; clients should branch on the prefix:

| Tag | Format | Meaning |
|---|---|---|
| `PREFILL_PROGRESS` | `PREFILL_PROGRESS:<progress 0-1>:<cumulativeTps>:<n_tokens>:<instantTps\|empty>` | live prefill rate. Field 2 is llama.cpp's CUMULATIVE rate (n/elapsed — a running average that decays across a long prefill); field 4 is the server-derived INSTANTANEOUS rate (delta between progress lines), empty on the first point. Prefer field 4 when present. |
| `GEN_PROGRESS` | `GEN_PROGRESS:<avgTps>:<instTps>:<n_decoded>` | live generation rate |
| `CTX_LIVE` | `CTX_LIVE:<n_prompt_tokens>:<n_ctx>:<is_processing 0/1>` | live context usage from the `/slots` poll |
| `COMPLETION` | `COMPLETION:<json>` | a request finished (any client); json below |
| `LANE_COMPLETION` | `LANE_COMPLETION:<json>` | a queue lane's request finished (its record-proxy tap's `end`): `runId` (`rec:<queue label>:<proxy seq>`, the key of its samples in `/api/logs/samples`), `timestamp`, `lane`, `server`, `model`, token counts and rates, draft numbers, `detail` (`lane`, `item`, `itemId`, `engine`, `cacheTokens`, `promptMs`, `genMs`). The end the tap replays on (re)connect is not sent again for a request already kept. |
| `BENCH:<line>` | `BENCH:<bench output line>` | llama-bench transcript line |
| (untagged) | anything else | raw master log line |

`COMPLETION` json (written to `logs/benchmarks.csv` at the same instant):

```json
{
  "runId": "1787386916304-a1b2c3",
  "timestamp": 1787386916304,
  "model": "Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf",
  "promptTps": 452.1, "genTps": 21.3,
  "promptTokens": 1280, "genTokens": 246,
  "wallTime": 12.1,
  "draftAcceptRate": null, "draftAccepted": null, "draftGenerated": null, "draftMeanLen": null,
  "aborted": false,
  "prefillTpsMin": 332.1, "prefillTpsMax": 664.0, "genTpsMin": 18.9, "genTpsMax": 24.2,
  "metrics": [ { "t": 0, "gpuUtil": 98, "gpuPwr": 287, "gpuTemp": 68, "vram": 21400, "cpuUtil": 40, "netMbps": 0.4 } ],
  "detail": { "modelPath": "...", "ctx": 32768, "ngl": 99, "rpc": "no", "launchCommand": "...", "config": {} }
}
```

`runId` is unique **per request**, not per launch session.
`prefillTpsMin/Max`, `genTpsMin/Max` are the per-request peak/low computed
server-side from the request's own sample series (null on rows logged
before the range columns existed); the CSV carries them as the trailing
`Prefill Tps Min/Max`, `Gen Tps Min/Max` columns.

## Launch control

### POST /api/start
Body: the structured launch config (same shape as `launchConfig` above).
Optional `rawCommand` field: when non-empty it is the source of truth —
it is tokenized (quote-aware) and run verbatim, and `-m`/`--port` plus the
device flags `-dev`/`-ts`/`--rpc` are synced back into the structured config
(`--rpc` endpoints are matched to configured workers). Every RPC worker the
launch uses is started over SSH first if it isn't running (and its ssh
forward opened), which can take several seconds. Without it, the command is
resolved from the structured fields (modelPath, build, ctx, ngl, port
required; devices/tensorSplit/rpcTarget/mmproj/mmprojOffload/spec/sampling/
argString optional). `mmprojEnabled` + `mmprojPath` emit `--mmproj PATH`;
`--no-mmproj-offload` (keep the projector in system RAM instead of VRAM) is
added unless `mmprojOffload: true` asks for VRAM, so an omitted field means
system RAM — only for builds whose `--help`
reference lists the flag (checked via the boot-warmed cache behind
`GET /api/flags`).

- `200 { "status": "launching" }`
- `400 { "error": "..." }` — already running, or invalid config
  (missing model, non-finite ctx/ngl, bad port, unknown build, unknown
  worker, a device listed twice), or `"RPC worker: ..."` when a worker
  couldn't be started or reached.
- `409 { "error": "Card busy: ...", "code": "CARD_BUSY", "busy": [{ "lane", "device", "card", "itemId", "label" }] }`
  — a running benchmark-queue item is on a card this launch needs (`lib/launchguard.js`, 2026-10-10). Nothing was
  started. Repeat the request with `"force": true` to launch anyway (the flag is not stored with the config).
  One `busy` entry per PHYSICAL card (2026-10-12): `card` is the card's label on this machine
  (`"RX 7900 XTX #2"`: identical cards are numbered), `device` the id the item reaches it through.
- `409 { "error": "This machine cannot run this launch as it is. Needs RTX 3060. Change its devices, or launch anyway.",
  "code": "UNAVAILABLE_HERE", "availability": { "status": "unavailable", "reason": "Needs RTX 3060." } }`
  — the availability gate (2026-10-13, `lib/topology.js` `launchGate`). Nothing was started. What is checked is what
  would run: the device ids in `rawCommand` when the request carries one (`"Needs device CUDA0 (named in its
  command)."`), else the saved device list and the ids in `argString`, plus `needs` when sent. A Strata launch names
  no device id: it is checked for the card count its config's own `gpu` list (or `--gpu`) asks for
  (`"Needs 2 cards."`), and for `needs` only when the request carries it (the web launcher sends the loaded
  profile's; without it, memory and card-size requirements are the client's load-time question only). `moved` and
  `substitute` launches are not refused. Repeat the request with `"allowUnavailable": true` to launch anyway: its own
  flag (`force` stays the busy-card answer; a request may need both), sent on the request only and never stored.
  Checked before `CARD_BUSY`. With no card known to the server (the device probe has not answered, a CPU-only
  machine) nothing is refused. Absent on a server older than 2026-10-13, which launches such a config and lets
  llama-server fail.

**Devices are re-pointed at this machine** (2026-10-12, `lib/topology.js` `launchDevices`; structured launches only,
a `rawCommand` runs verbatim). Each local device `{ id, name?, vramMib? }` is resolved against the build's device
list: the card it names under its own id is kept; the same card under another id is used with a warning
(`"RX 7900 XTX #2 moved from ROCm1 to Vulkan1; using Vulkan1"`) — two identical cards stay two cards; a card this
machine lacks is replaced by a free card at least as big when the device carries `vramMib` (`"RTX 3060 is not in
this machine; using RX 7900 XTX #2 (ROCm1) instead -- not validated here"`); otherwise the id is left alone with a
warning and llama-server reports it. `specDraftDevice` follows its card. Device ids inside `argString`
(`-ot '...=CUDA0'`) are NOT rewritten.

A bare id (a device with no `name`) that this build does not list has one fallback (2026-10-13): when the machine's
fullest device list knows the id as a card and this build reaches that same physical card, the device moves to this
build's id for it (`"ROCm1 is RX 7900 XTX #2 on this machine; this build reaches it as Vulkan1; using Vulkan1
(identical cards paired by listing order)"`). Otherwise it is left alone with a warning, as before; it is never placed
by its number or on the first free card.

**Paths** (2026-10-13, `lib/paths.js`): `modelPath`, `specDraftModel`, `mmprojPath`, `chatTemplateFile`, `strataBase`
and the words of `rawCommand` may be written `~/...` or `${NAME}/...` (`dashboard.config.json` `pathRoots`, else the
environment; `${MODELS}` is `modelsRoot`), and a model path may be relative to `modelsRoot`. They are expanded before
anything else reads the config. An absolute path is used as it is.

`splitMode` (optional, 2026-10-12): how a launch on two or more devices is divided — `"layer"` (the default, and what
an absent field means: `--split-mode layer`, as before) or `"tensor"` (`--split-mode tensor`, experimental in
llama.cpp). `"row"` is refused with a 400: it is deprecated in llama.cpp and fails to load. A `-sm` / `--split-mode`
in `argString` comes later on the command line and wins.

### POST /api/preview-command
Same body, no side effects. Returns the exact command that `/api/start`
would run, plus the resolved device list and any id warnings:
`200 { "command": "/path/llama-server -m '...' ...", "devices": [...], "warnings": ["AMD Radeon RX 7900 XTX moved from Vulkan0 to Vulkan1; using Vulkan1"] }`
or `{ "command": "", "error": "..." }`. Shell-quoted, copy-pasteable.
The response also carries `"busy": [...]` (same entries as the 409 above; `[]` when the cards are free), so a
client can warn before the launch is attempted.

Added 2026-10-12 (all additive): `"placement"` — where the launch sits on this machine, in words
(`"2x RX 7900 XTX, 1:1"`, `"RX 7900 XTX #2 alone"`, `"CPU only"`); `"splitMode"` — `"layer"` / `"tensor"` for a
launch on two or more devices (read from `splitMode` or a `-sm` in `argString`), else `null`; `"status"` —
`ready` / `moved` / `substitute` / `unavailable`, how the config's devices resolved (see `/api/start`);
`"signature"` — the machine in one line. `devices` is the RESOLVED list (the ids that will run), and `warnings`
says what was re-pointed, substituted or missing, and warns about `-sm row`.

### POST /api/stop
`200 { "status": "stopped" }`. SIGTERM, SIGKILL after 3 s.

### GET /api/models
`200 [ { "name": "x.gguf", "file": "x-00001-of-00003.gguf", "path": "/abs/path", "realPath": "/abs/real", "aliases": [], "size": "20.75", "bytes": 22280000000, "parts": 3, "source": "local|huggingface", "kind": "model|mmproj|draft|other", "mmproj": null } ]`
(from `../models`, `/data/models`, the HF cache, then `dashboard.config.json`
`modelDirs`, all recursive; lib/modelscan.js). A split model is one entry at
part 1's `path` (what llama.cpp is given); `name` drops the `-0000N-of-0000M`
suffix and `size` (GiB) / `bytes` cover every part (`missingParts` lists any
absent). A file reachable by several paths (symlink, byte-identical copy) is
listed once at the first path found; the others are in `aliases`.
`kind` (ui/shared/modelname.js `modelFileKind`): the launch select, model
picker, bench dropdowns and dash-cli offer only `model`; `mmproj` and `draft`
entries stay in the response for the mmproj auto-fill (each model's `mmproj`)
and as suggestions on the mmproj / draft-model path fields.

### GET /api/builds
`200 { "builds": [ { "id": "vulkan-cuda", "label": "Vulkan + CUDA", "path": "/abs/path/llama-server" } ] }`
(from `dashboard.config.json`; `path` is the expanded path when the config wrote it with `~` or `${NAME}`). `id` is
the value used in every `build` field and `?build=` query param.

### GET /api/devices?build=<id>[&refresh=1]
```json
{ "devices": [ { "id": "CUDA0", "description": "NVIDIA GeForce RTX 3060", "totalMib": 11906, "freeMib": 10794 }, ... ],
  "cards":   [ { "name": "NVIDIA GeForce RTX 3060", "vendor": "nvidia", "preferredId": "CUDA0", "ambiguous": false,
                 "backends": [ { "id": "CUDA0", "totalMib": 11906, "freeMib": 10794 }, { "id": "Vulkan0", ... } ] } ],
  "workers": [ { "name": "laptop", "ssh": "laptop", "port": 50052, "devices": "CUDA0", "deviceCount": 1, "cache": true, "link": "ssh" } ] }
```
`devices` is the raw `--list-devices` listing. `cards` groups it per physical
GPU, since one NVIDIA card appears as both `CUDA0` and `Vulkan0` in a
CUDA+Vulkan build. `preferredId` is CUDA for NVIDIA cards, ROCm then Vulkan
for others. Identical cards can't be told apart by name and are flagged
`ambiguous`. `workers` are the configured RPC workers. On failure:
`{ "devices": [], "error": "timed out|failed" }` (enumeration can hang on a
bad eGPU link; fall back to manual entry).

Since 2026-10-12 the response also carries `"topology"`: the machine as that build sees it (see
`GET /api/topology`). Its cards carry the labels to show (`"RX 7900 XTX #1"` / `"#2"` for identical cards); `cards`
stays as it was for older clients.

**When this runs the binary** (2026-10-13, `lib/deviceprobe.js`). Until then every call ran `--list-devices`; a probe
initialises every backend on every card and stalled a two-card engine mid-decode. Now a probe runs only with
`refresh=1`, or while nothing is on a local card (a model this dashboard launched, a launch or benchmark in progress,
a running queue item on a `local-*` lane, another server on the managed port, or a card telemetry shows loaded);
the server also probes at boot. Otherwise the answer comes from the cache. Additive fields, all absent on an older
server:

- `cached` (bool): the listing was not produced by a probe during this call, or the probe failed and an earlier
  listing is shown. `cachedAt` (ms epoch) / `ageMs`: when it was produced. `probed` (bool): a probe ran now.
- `note` (string or null): why, in words — `"not re-probed (queue item 942 is running on lane local-gpu); device list
  from 45 min ago"`, `"the probe timed out; showing this build's device list from 60 s ago"`.
- `error`: set when a probe ran and failed (`"timed out"`). **A failed probe no longer empties the answer**: when any
  earlier listing exists, `devices` / `cards` / `topology` are that listing and `error` rides beside it. Only with
  nothing to show is the answer `{ "devices": [], "cards": [], "error": "..." }` (fall back to manual entry).
- `borrowed` (bool) / `from` (build id): this build has no listing of its own (never probed successfully), so the
  cards are shown as the build with the fullest listing sees them. The ids may not exist in this build, and
  `/api/start` does not re-point a launch against a borrowed list. `cached` is `true` and `note` says whose it is.

A client should show `note` when present, treat `cached` as a normal answer, and send `refresh=1` only when its user
asks for a probe.

**2026-10-17 (`lib/gpusafety.js`): no probe while the queue has work on this machine's cards, `refresh=1` included,
and none at boot.** The hard signals: a running queue item on a `local*` lane, a `local*` lane's `queue_runner.py`
with processes under it (read from /proc, so a lane still loading its engine counts), a battery holding
`/tmp/codebench-lldash.lock`, or a queue database that could not be read. A `refresh=1` turned down for one of them
answers like any cached answer plus `"refused": true`, and `note` names the reason. The soft rule above (a model this
dashboard launched, a card telemetry shows loaded, and now also "no telemetry reading yet" right after a start) still
yields to `refresh=1`. `GET /api/flags?refresh=1` follows the same hard rule. The server no longer probes at boot: it
serves the listings kept in `logs/device-cache.json` and probes a build without one on demand, under these rules.

### GET /api/topology
This machine's hardware as the dashboard models it (`lib/topology.js`, 2026-10-12), from the fullest cached
`--list-devices` listing (the build that sees the most devices sees every card through some backend):

```json
{ "cards": [ { "key": "amd radeon rx 7900 xtx#1", "name": "AMD Radeon RX 7900 XTX", "short": "RX 7900 XTX", "label": "RX 7900 XTX #1",
               "vendor": "amd", "ordinal": 1, "count": 2, "vramMib": 24560, "ids": ["ROCm0", "Vulkan0"], "preferredId": "ROCm0", "orderAssumed": true },
             { "key": "amd radeon rx 7900 xtx#2", "label": "RX 7900 XTX #2", "ordinal": 2, "ids": ["ROCm1", "Vulkan1"], "preferredId": "ROCm1", ... } ],
  "hostRamMib": 64223,
  "workers": [ { "name": "laptop", "ssh": "laptop", "devices": "CUDA0", ... } ],
  "signature": "2x RX 7900 XTX 24G | 63G RAM" }
```

One entry per PHYSICAL card. `key` is stable across builds and restarts and tells identical cards apart; `label` is
what to show (`short` plus `#n` when there is more than one of that model); `ids` are every llama.cpp id that reaches
the card. `orderAssumed`: the card's ids under different backends were paired by listing order, because nothing in
`--list-devices` says which Vulkan id is which ROCm id. `cards` is `[]` on a CPU-only machine or before the first
device probe has answered (`signature` then starts `"no GPU"`). RPC workers are other machines' cards and are listed
separately. See `TOPOLOGY.md`.

### GET /api/flags?build=<id>[&refresh=1]
`200 { "flags": [ { "flags": "-c, --ctx-size N", "description": "...", "section": "general", "insertText": "--ctx-size ", "primaryFlag": "--ctx-size" } ] }`
(parsed from the build's `--help`, cached per build). Running `--help` loads every backend, so since 2026-10-13 a
build whose flags are not cached yet is not read while something is on a local card (the rule of `/api/devices`):
`200 { "flags": [], "error": "not read while the cards are busy (...)", "deferred": true }`. `refresh=1` reads anyway --
except while the queue has work on the cards (2026-10-17, the hard rule of `/api/devices`).

### GET /api/strata/configs
The base configs of the Strata engine, across every configured install (2026-10-13; `dashboard.config.json`
`strataInstalls`, the `STRATA_DIR` environment variable first; before that, one directory written into the code):

```json
{ "dir": "/opt/Strata-0.1.32", "serveScript": "/opt/Strata-0.1.32/queue-serve.sh",
  "configs": [ { "path": "/opt/Strata-0.1.32/strata-iq3_xxs.json", "name": "strata-iq3_xxs.json", "maxContext": "131072",
                 "install": "/opt/Strata-0.1.32", "version": "0.1.32" },
               { "path": "/opt/Strata-0.1.43.1/strata-iq3_xxs.json", "name": "strata-iq3_xxs.json", "maxContext": "131072",
                 "install": "/opt/Strata-0.1.43.1", "version": "0.1.43.1" } ],
  "installs": [ { "dir": "/opt/Strata-0.1.32", "version": "0.1.32", "label": "Strata 0.1.32", "serveScript": "...", "configs": 9 }, ... ] }
```

`path` / `name` / `maxContext` are as before; `install` and `version` are new on each entry (two installs hold files
of the same name: tell them apart by `path`). `version` is the install's `VERSION` file, else the number in its
directory name, else `null`. `dir` / `serveScript` are the FIRST install's, for older clients, and `null` on a
machine with no install. `installs` is always an array on a server of this date (`[]` = no Strata here); its absence
means an older server that lists one directory only. A profile's `strataBase` is matched against `configs[].path` as
an exact string. A launch uses the launcher (`queue-serve.sh`) of the config's own install.

2026-10-17: each `installs[]` entry carries `thpOff` (its `queue-serve.sh` runs the server under the `nothp` wrapper,
prctl PR_SET_THP_DISABLE -- Strata 0.1.44.1's launcher does; read from the script, a comment does not count). Each
`configs[]` entry carries `settings`: what the file sets for every override field, in the override names
(`{ maxContext, kv, kvResident, ropeScaling, ropeScale, spec, specMinP, pipelineWindows, residentBudgetGib, gpu,
layerSplit, stageTrim, kernelCopy, temperature, topK, topP }`, `null` where the file sets nothing; `gpu` as `"0,1"`,
`stageTrim` / `kernelCopy` as `"on"` / `"off"`), so a form can show the base value next to a blank field. The answer also
has `kvTypes` (what `--kv` takes: `int8`, `fp16`, `q4_0`, `k8v4`) and `overrideKeys` (the override fields this server
merges). Order of `installs` = `strataInstalls` order; the first is the "current" one (`dir` / `serveScript` above).

### Strata overrides (POST /api/strata/preview, /api/preview-command, /api/start, saved profiles)
A Strata launch is `{ engine: "strata", strataBase, ...overrides }` (`/api/strata/preview` takes
`{ base, overrides }`). Every override is optional; blank / `null` keeps the base file's value. lib/strata.js merges
them into a copy, `logs/strata-dashboard/<base>.<install version>.dash.json` (before 2026-10-17 `<base>.dash.json`,
which two installs with the same file name shared), and launches that copy with the base's own `queue-serve.sh`.
Overrides that only repeat the file launch the file itself.

| key | writes | values |
|---|---|---|
| `maxContext` | `--max-context` | tokens > 0 |
| `kv` | `--kv` | `int8`, `fp16`, `q4_0`, `k8v4` (`f16` is read as `fp16`, `q4` as `q4_0`) |
| `kvResident` | `--kv-resident` | tokens > 0 |
| `ropeScaling` / `ropeScale` | `--rope-scaling` / `--rope-scale` | `yarn` (or `none`: both flags removed) / factor > 0 |
| `spec` / `specMinP` | `--spec` / `--spec-min-p` | draft tokens > 0 / 0..1 |
| `pipelineWindows` | `--pipeline-windows` | `0` (off), `1`, `2` -- 0 is a value |
| `residentBudgetGib` | `--resident-budget-gib` | GiB > 0 |
| `gpu` | the config's `"gpu"` | `"0"`, `"0,1"` or `[0, 1]` (one card is written as a number) |
| `layerSplit` | the config's `"layer_split"` | `"auto"`, or the first layer of each later card, rising from 2 (`"27"`, `"16,32"`) |
| `stageTrim` | env `STRATA_STAGE_TRIM=1` | `on` / `off` (off removes it from the copy's env) |
| `kernelCopy` | env `STRATA_HIP_ADAPT_KERNEL_COPY=1` | `on` / `off` |
| `temperature`, `topK`, `topP` | the `sampling` block | numbers |

Refused before anything starts (`/api/strata/preview` answers `{ command: "", error }`, `/api/preview-command` an
`error`, `/api/start` a 500 with the reason): a value outside the table, a layer split whose count does not match the
cards (`gpu` override, else the file's), and `pipelineWindows` / `residentBudgetGib` on a config whose engine binary does
not contain that option (Strata 0.1.32 has no `--pipeline-windows`; the binary is read once, the way serve/server.py
checks for `--tail-role-token`). A profile's `gpu` override also counts for its availability (`GET /api/profiles`).

### GET /api/models/catalog · GET /api/model?key=<key>
**Diagnostic tasks** (2026-10-17): a task whose task.yaml `category` includes `diagnostic` (a functional
check, "like a speed test, that isn't a quality test") is in `taskMeta` with `diagnostic: true` and listed in
`diagnosticTaskIds`, but in no scored figure: not in any model's or config's `quality` / `agg` / `tasks`, not in
`taskTotal` (coverage denominators) or `allTaskIds` (the planner's candidates), so not in the strength fit or task
points either. Its results are `diagnostics` (`{ <task>: { diagnostic, status, solved, excluded, credit, attempts,
passes, wall_s, tokens_out, ran_at, dir } }`) on each model and on each `configs[]` entry that ran it. The public
catalog keeps the flag and the `diagnostics` maps.
Rows whose key carries a row variant listed in `dashboard.config.json` `internalRowVariants` (`<model>~rv:<slug>`,
the slug of a queue item's `CODEBENCH_ROW_VARIANT`) are left out of the catalog and of everything built from it
(boards, task history, the public site's catalog), and `GET /api/model?key=` answers `404` for them (2026-10-13).
Nothing is deleted: the batteries stay listed under Bench -> codebench and their result files and database rows are
untouched. On the lab dashboard only, `GET /api/model?key=<key>&internal=1` still opens such a row.

## Launch profiles (shared by web UI + llama-cli)

The single source of truth for saved launch configs, stored in
`logs/profiles.json` (next to the benchmark CSV). The browser UI migrated
its former per-browser localStorage profiles here; `llama-cli` migrated its
former `~/.llama-cli/profiles.json` here (the server imports that file once
at first boot). Both clients read/write through these endpoints.

Document shape (schema v3):

```json
{
  "version": 3,
  "profiles": {
    "qwen-27b-dual": {
      "config": { "modelPath": "...", "build": "vulkan-cuda", "ctx": 262144, "ngl": 999, "port": 8080, "deviceA": "CUDA0", "deviceB": "Vulkan2", "tensorSplit": 40, "fa": true, "cacheK": "q8_0", "cacheV": "q8_0", "specType": "draft-mtp,ngram-map-k4v", "specDraftNMax": 2, "temp": 1, "topK": 20, "topP": 0.95, "jinja": true, "reasoningPreserve": true, "verbosity": 3, "argString": "--spec-draft-device CUDA0 -fitt 256" },
      "savedAt": 1787386000000,
      "lastLoadedAt": 1787386916000
    }
  }
}
```

`config` holds the same keys as `launchConfig`/`buildLlamaArgs` (see
`POST /api/start`), so a profile applies to either client without
translation. `lastLoadedAt` drives the web dropdown's most-recently-used
sort; both clients stamp it (load-mark) when a profile is applied.

A config may also carry (all optional, 2026-10-12): per local device `vramMib` (the card's memory when the profile
was saved — lets another machine offer a card at least as big); `splitMode` (`"tensor"`, see `/api/start`); and
`needs: { vendor?, minVramMib?, minCards?, hostRamMib? }` — what a machine must have for a profile whose launch names
no devices (an engine with its own launcher). The web UI saves `vramMib` with every profile and keeps `needs` when a
loaded profile is saved again.

### GET /api/profiles
`200` the document above (empty `{ "version": 3, "profiles": {} }` if none), plus two fields computed per request for
THIS machine and never stored (2026-10-12):

- `availability`: `{ "<profile name>": { "status", "reason", "placement", "devices"? } }`
  - `status`: `ready` (runs as saved) · `moved` (the same cards under other ids here) · `substitute` (a card this
    machine lacks is stood in for by one at least as big; not validated) · `unavailable`
  - `reason`: `""`, `"RX 7900 XTX: ROCm1 is now Vulkan1."`, `"RTX 3060 is not in this machine; RX 7900 XTX #2 (24 GB)
    stands in. Not validated on this machine."`, `"Needs RTX 3060."`, `"Needs 46 GB of memory (this machine has 31)."`
  - `placement`: where it would run here (`"2x RX 7900 XTX, 1:1"`), `null` when unavailable or when the profile
    lists no devices
  - `devices`: for `moved` / `substitute` only — the profile's device list re-pointed at this machine, for a client
    to load in place of the saved one. (`/api/start` resolves the same way, so sending the saved list also works.)
- `topology`: as `GET /api/topology`.

A client should list runnable profiles first and not launch an `unavailable` one without asking (`/api/start`
refuses it with `409 UNAVAILABLE_HERE` unless the request carries `allowUnavailable: true`). Both fields are
absent on a server older than 2026-10-12: treat every profile as `ready`.

Path fields (`modelPath`, `specDraftModel`, `mmprojPath`, `chatTemplateFile`, `strataBase`, and `rawCommand`) are
served EXPANDED (2026-10-13): a profile stored as `${MODELS}/x.gguf` or `~/x.gguf` arrives as this machine's
absolute path, so a client compares it with `/api/models` exactly as before. A profile stored with absolute paths is
served as stored.

### POST /api/profiles
Body `{ "name", "config"?, "lastLoadedAt"? }`:

- with `config`: upsert the profile. `savedAt` is stamped server-side.
  `config.modelPath` (when present) is validated against the filesystem —
  `400 { "error": "Model path not found: ..." }` otherwise. A path field that is exactly the expansion of the one
  already stored keeps the stored spelling (2026-10-13), so loading and saving a portable profile does not turn it
  back into absolute paths; anything else is stored as sent.
- without `config` (a **load-mark**, `{ "name", "lastLoadedAt" }`): updates
  only `lastLoadedAt` on the existing profile, keeping its stored config
  and skipping model-path revalidation (the model file may have moved).
  `404` if the profile doesn't exist.

`200 { "ok": true, "name" }` · `400` bad name (1-80 chars) / empty config /
missing model file.

### DELETE /api/profiles/<name>
`200 { "ok": true, "name" }` · `404 { "error": "Profile ... not found" }`.
Name is URL-encoded (it may contain spaces or `/`).

## Telemetry

### GET /api/telemetry/latest
`200 { "t": <ms epoch>, "stats": {...} }` (`{ "t": 0, "stats": null }` until
the first sample). The server polls `monitor.py` (:8081) at a fixed rate and
caches — this endpoint never shells out. `stats`:

```json
{ "hosts": { "local":  { "cpu_name", "cpu_util", "cpu_temp", "ram_used", "ram_total", "process_ram", "net_bytes", "net_by_interface", "error" },
             "laptop": { ... } },
  "gpus":  [ { "host": "local", "index": 1, "pci": "0e:00.0", "vendor": "amd", "gpu_name": "AMD Radeon RX 7900 XTX",
               "label": "RX 7900 XTX #2", "card": "amd radeon rx 7900 xtx#2",
               "gpu_util", "vram_used", "vram_total", "process_vram", "gpu_pwr", "gpu_temp", "mem_temp", "fan_rpm", "fan_pct",
               "gpu_throttle", "throttle_reasons", "error" }, ... ],
  "devices": [ { "id": "ROCm1", "name": "AMD Radeon RX 7900 XTX", "label": "RX 7900 XTX #2", "host": "local", "pci": "0e:00.0", "share": 50,
                 "util", "pwr", "temp", "mem_temp", "fan_rpm", "fan_pct", "vram_used", "vram_total", "thermal" }, ... ],
  "master": {...}, "worker": {...} }
```

- `gpus`: every GPU `monitor.py` sees. That's all local NVIDIA cards
  (nvidia-smi) and AMD cards (amdgpu_top; hwmon power/temp matched by PCI),
  plus the GPUs of each RPC worker the running launch uses (over ssh, under
  that worker's name as `host`).
  Since 2026-10-12 each entry also has `label` (the card as the dashboard names
  it; identical cards are numbered, by PCI address order — the same by-order
  assumption as the topology's `orderAssumed`), `card` (its topology card key,
  `null` for a GPU llama.cpp does not list or a worker's), and three sensors
  that are `null` where the card has none: `mem_temp` (°C), `fan_rpm`,
  `fan_pct` (AMD: hwmon `fan1_input`, `pwm1`/`pwm1_max`, the `mem` temperature;
  NVIDIA: `fan.speed` only). A stopped fan reads `0`, not `null`.
- `devices`: one reading per launch device, in launch order (`null` with no
  launch, and for a launch that names no device). A local device takes the
  reading of the PHYSICAL card its id reaches (2026-10-12: by card name alone,
  a launch on the second of two identical cards got the first card's
  readings); `pci` says which entry of `gpus` that is, and `label` tells
  identical cards apart. Workers are matched by host.
  A device whose GPU isn't in telemetry has `null` readings.
- `master`/`worker` (legacy): the first two launch devices, or with no
  launch the two largest local GPUs, each merged with its host's CPU/RAM/net.
  Fields: `gpu_name`, `gpu_util` (%), `vram_used`/`vram_total` (MB),
  `process_vram` (MB used by llama-server/ggml-rpc-server), `gpu_pwr` (W),
  `gpu_temp` (°C), `gpu_throttle`, `throttle_reasons`, `ram_used`/`ram_total`
  (MB), `process_ram`, `cpu_name`, `cpu_util` (%), `cpu_temp` (°C),
  `net_bytes` (cumulative), and `nvidia_smi_error` or `amdgpu_top_error`.
  `master` is `gpu_name: "Offline"` when no GPU is found; `worker` is
  omitted when there's no second GPU.

Per-request chart samples (`metrics` in COMPLETION, `/api/logs/samples`)
carry `devices: [{ id, label, host, util, pwr, temp, vram (GB), thermal }]`
alongside the legacy `master*`/`worker*` fields. CSV rows append a
`devices_json` column with the completion-time `devices` readings.

### GET /api/debug/requests
The request tally since the server started (lib/reqtally.js, 2026-10-22), behind the gate: `total`, `perMin`,
`via` (`tunnel` = a Host header that is not this machine, `local`), `hosts`, `auth` (credentials as sent:
`bearer` / `cookie` / `none`), `status`, `recent` (the last 10 whole minutes: `perMin` and `byPath`), `byPath`
(pattern -> `n`, `perMin`, `tunnel`, `local`; no query string, ids and `/v/<hash>/` folded), `topAgents`, and
`lastMinutes` (per-minute counts over the last hour). In memory only; a restart starts it again.

### POST /api/telemetry/rate
Body `{ "ms": 250..5000 }` → `200 { "ok": true, "ms": 1000 }`.

### GET /api/lanes/live
Combined live t/s across local GPU queue lanes (2026-10-01; server4.js `lanesLive`,
`lib/lanetps.js`). A local lane = codebench `queue_lanes.runtime_json` has a `tap_port` and
a `queue_items` row is `running` on it. With 0-1 such lanes → `{ "combined": false, "lanes": <n> }`
and nothing is dialled. With 2+ → `{ combined: true, gen, prefill, genText, prefillText,
lanes: [{ lane, label, gpu, engine, item, model, tap, connected, gen, genSrc, prefill,
prefillSrc, phase, progress, read, total, generated, ctx, ctxMax, edgeAt, ... }] }` where `gen`/`prefill` are the sums and `genText` reads
e.g. `"RX 7900 XTX #1 Strata 51 · RX 7900 XTX #2 llama 24"`. A lane's `gpu` / `label` come from where its
processes hold VRAM (PCI bus -> that reading's label), else from its `runtime_json` device list read against this
machine, else from the card name its runner published (a remote lane: `"RTX 4090 Laptop"`); never from the lane's
name or a queue item's label (2026-10-12). Per lane, gen comes from the engine's live counters
(`genSrc` `slots` = llama-server `/slots`, `metrics` = Strata `/metrics` `live`), falling back
to the record-proxy tap (`stream`/`last`); prefill is the live mid-read rate, else the latest
request's exact `prompt_per_second` from the tap (`tap`) while the lane is busy. A lane idle
> 5 s contributes 0. Polling this keeps the lane taps and ~1 Hz engine polls alive; they stop
30 s after the last poll. The web UI polls it every 1 s while combined, 3 s otherwise.

### GET /api/queue — lane cards (2026-10-12)
The queue API itself is `lib/queue.js` `handleApi`. Its `lanes` rows additionally carry, computed per request for this
machine (`lib/queue.js` `laneCardInfo`, `lib/topology.js` `laneCards`):

- `card`: `{ "label", "here", "remote" }` — `label` `"RX 7900 XTX #2"` / `"2x RX 7900 XTX"` / `"RTX 4090 Laptop"` /
  `null`; `here` `true` (on cards this machine has), `false` (on cards it lacks), `null` (the lane says nothing);
  `remote` `true` for another machine's lane. From the lane's `runtime_json` (`devices`: llama.cpp ids for a lane
  serving here; `gpu`: the card name a runner published). By the queue's convention `local-*` lanes run on this
  machine; a local lane with a serving port and no device list takes every card.
- `parked`: `true` for a lane that is paused with no live runner, or set up for cards this machine does not have.
  The queue view folds those away unless something is running on them.

and the response has `machine` (the topology `signature`).

### POST /api/queue/item/duplicate — where the copy goes (2026-10-26)
`{ "id", "position"? }` → `200 { "item" }`: a copy of the item as a new pending row (label `<label>-rN`; a finished run
item runs the tasks it resolved to). `position`:

- `"top"`: ahead of every pending or held item of the item's lane (just before the first one, after the running item),
  so the lane's runner starts it next; with nothing waiting, the end. Positions also order items across GPU lanes
  (the runner's device gate), so the copy takes the lane head's place there too, as an item moved to the top does.
- `"end"`: after the lane's last row.
- `"after"`: right after the item copied (a pending or held item only; a finished one is a `400`).
- left out: as before 10-26 — a pending / held item's copy right after it, a finished one's at the end. Scripts that
  copy an item and then edit it (`sweeps/watchers/replan.py`) rely on this.

The Queue page's "again ↑" (recent history) sends `"top"` (Kyle 2026-10-26: a re-queued item goes to the top of its
lane, not the bottom); its "dup" on a waiting item sends none. Any other value is a `400`.

## Request history (all from `logs/benchmarks.csv`)

### GET /api/logs/recent?limit=N
`200 { "rows": [ { "timestamp", "runId", "model", "transport", "promptTps", "genTps", "promptTokens", "genTokens", "wallTime", "draftAcceptRate", ..., "aborted", "detail": { "modelPath", "ctx", "ngl", "argString", "launchCommand", "loadTime", "gpuUtil", "gpuPwr", "gpuTemp", "cpuUtil", "vram", "ram", "wGpuUtil", ..., "config": {...}, "deviceStats": [ { "id", "name", "label", "host", "share", "util", "pwr", "temp", "vram_used", "vram_total", "thermal" } ] } } ] }`
(oldest→newest; null for missing numeric fields). `deviceStats` is the CSV's
`devices_json` column (every launch device at completion), `null` on rows
logged before it existed.

### GET /api/logs/samples?runId=<run_id>[&at=<ms>]
`200 { "samples": [...], "note"?, "reason"? }` — the sample series for that request (2026-10-22, lib/reqsamples.js):
LL-Dash's own server's requests (CSV run id) and every queue lane's (`rec:<queue label>:<proxy seq>`, the
`LANE_COMPLETION` row's `runId` -- also the run id a Strata leg's proxy recording is imported under), kept in
bench.sqlite `request_samples` (the newest 50,000 requests, none older than 14 days; a dashboard restart keeps them).
A lane sample: `t`, `phase`, `prefillTps` (this request's live rate, else its exact average), `prefillTpsAvg`,
`prefillProgress`, `prefillPos` / `prefillTotal`, `genTps`, `genTokens`, `ctx` / `ctxMax` (context in use / the
server's), the lane's cards' `devices`, `src` (`engine` = the engine's live counters, `tap`, `timings` = anchors placed
from the engine's own `prompt_ms` / `predicted_ms` at the read's and the answer's start and end). Missing fields are
null. `note` says what the series is when it is not plain live ticks (shorter than one tick, the dashboard connected
mid-request). With fewer than 2 samples, `reason` says why in one sentence (before per-request telemetry was kept,
older than the kept window, imported from a log, the request failed before the engine reported timings); `at` (the
row's time, ms) sharpens it for a row whose run id carries no time.

### GET /api/logs/active-samples
`200 { "samples": [...] }` — peek at the in-flight request's samples.

### GET /api/logs/summary?model=<basename>&transport=<Local|WiFi|TB4>
`200 { "count", "avgPromptTps", "avgGenTps", ..., "lastRun": {...} }`
(aggregate stats for the filter).

### GET /api/logs/csv
`200` raw CSV (Content-Type: text/csv), 404 if absent.

## Bench (llama-bench, server-side queue)

### POST /api/bench/start
Single: `{ "modelPath", "rawArgs"?, "fa"?, "cacheK"?, "cacheV"?, "nPrompt"?, "nGen"?, "depths"?, "reps"?, "devices"?, "splitMode"?, "tensorSplit"?, "extraArgs"?, "label"? }`
or a matrix: `{ "queue": [cfg, ...] }` (runs chain server-side and survive
client disconnects). `409` while a bench is running or while the model
server holds VRAM.

### GET /api/bench/status
`200 { "running", "command", "output": [lines], "queueRemaining", "queueTotal", "currentLabel", "samples": [...] }`

### POST /api/bench/stop · /api/bench/dequeue `{label}` · /api/bench/note `{lines:[...]}` · /api/bench/clear · /api/bench/restore

`/api/bench/note` appends client-composed result blocks to the same
`bench-history.log` transcript as bench runs.

## Worker (RPC over SSH)

### GET /api/worker/config
`200 { "ssh", "port", "devices", "cache", "link", "workers": [ { "name", "ssh", "port", "devices", "deviceCount", "cache", "link" } ] }`.
`workers` comes from `dashboard.config.json`'s `rpcWorkers` map (an invalid
entry is listed as `{ name, error }`). The top-level fields describe the first
valid worker, for clients that only know one.

### POST /api/worker/start `{worker}` or `{worker_ssh}` · /api/worker/stop · /api/worker/status · /api/worker/logs
`worker` is an `rpcWorkers` name; `worker_ssh` is an ssh target (the web and
CLI worker fields), matched to a configured worker by its `ssh` or used ad hoc
with default settings.
Manage the remote `ggml-rpc-server` process over SSH (no Docker): start runs
it detached with `-H 0.0.0.0 -p <port> [-d <devices>]` and fails with the log
tail if it exits within 3 s; stop is `pkill -x` (SIGKILL after 3 s); status
returns `{ "status": "running" | "stopped" | "offline" }` (`offline` = SSH
failed); logs returns `{ "logs" }`, the last 50 lines of `rpcWorker.logFile`.

## Remote access (tunnel gate)

A Cloudflare **quick tunnel** (`cloudflared tunnel --url http://127.0.0.1:3000`,
trycloudflare.com — no account) can publish this dashboard to a random
`https://xxx.trycloudflare.com`. Because cloudflared forwards from localhost,
tunnel and local traffic are indistinguishable, so starting the tunnel **arms
a global password gate**: while it is up, every request (static files, REST,
SSE — local or remote) must authenticate. The only unauthenticated response
is the gate itself. Stopping the tunnel drops the gate; local use is exactly
as before.

The gate is checked before any route. Two credential forms are accepted,
checked per request:

- `Authorization: Bearer <password>` — for CLIs and scripts (e.g.
  `llama-cli -s https://xxx.trycloudflare.com --token <pw>`).
- `mc_session=<token>` cookie — for browsers, set by the login route below
  (HttpOnly, SameSite=Lax, 24 h). Tokens live in memory and die on restart.

The password is stored as PBKDF2-HMAC-SHA256 (200k iterations) against a
**random per-boot salt**; nothing is persisted, so restarting the dashboard
revokes the tunnel, the gate, and every session. A failed tunnel start clears
all gate state (it can never leave the dashboard locked with no working
password).

### GET /api/tunnel
`200 { "active": <bool>, "starting": <bool>, "url": "<https://…|null>" }`
`active` is true only once cloudflared has produced a URL.

### POST /api/tunnel
Body `{ "action": "start", "password": "…" }` (password min 4 chars) or
`{ "action": "stop" }`.

- start: `200 { "active": true, "url": "https://xxx.trycloudflare.com" }` —
  blocks until the URL appears (≤ 30 s). `400 { "error": "…" }` if the
  password is too short, cloudflared is missing/failed, or a tunnel is
  already running.
- stop: `200 { "active": false }`.

While the gate is armed, a request without credentials gets:
- `401` + the gate HTML page, when `Accept` includes `html` (browsers);
- `401 { "error": "authentication required (tunnel gate active)" }` otherwise
  (API/SSE clients — the CLI turns this into a password prompt).

### POST /api/tunnel/login
The **only** route reachable while the gate is armed. Body `{ "password" }`.
- `200 { "ok": true }` + `Set-Cookie: mc_session=…` (correct password).
- `401 { "error": "invalid password" }`.

Requires `cloudflared` on the dashboard host's `PATH`. The dashboard's
`shutdownHandler` (SIGINT/SIGTERM) kills the cloudflared child, so the
tunnel dies with the process.

## Chat (streaming pass-through to the model server)

### POST /api/chat
A thin streaming proxy to the running `llama-server`'s
`/v1/chat/completions`. The request body (messages, `tools`,
`chat_template_kwargs` — e.g. `{ "enable_thinking": false,
"reasoning_effort": "low" }` — `max_tokens`, `stream`, `image_url` content
parts) passes through **verbatim**, and the upstream response (SSE or JSON)
is piped straight back, so both the web UI and the CLI can share one
implementation and stream identically.

- The model port is derived from the current launch command
  (`portFromLaunchCommand()`, default 8080).
- `409 { "error": "no model running" }` when the server state isn't `ready`.
- `502` when the model server is unreachable.
- Client abort destroys the upstream request.

This is how the CLI's Chat mode and the web UI talk to the model; it is the
tunnel-safe twin of hitting `:8080` directly. The server's client-agnostic
capture (CSV + `COMPLETION`) still records every request, from any client.

### GET /api/slots
A GET proxy to the model server's `/slots` (same port derivation as
`/api/chat`). Used by the sidebar's prefill/progress poll so it works
through a tunnel instead of hardcoding `localhost:8080`. `409` with no model
running, `502` if unreachable.

## Web search (keyless, server-side)

### POST /api/web-search
Keyless DuckDuckGo HTML search, run **server-side** so no client needs an
API key and the same code serves the web UI and the CLI. Body
`{ "query", "num"? }` (`num` clamped to 1–8, default 5).

- `200 { "query", "count", "results": [ { "title", "url", "snippet" } ] }`
  (DDG redirect wrappers are decoded to the real URL).
- `400 { "error": "query is required" }` · `502 { "error": "web search failed: …" }`
  (15 s upstream timeout).

Used as the `web_search` tool in the chat modes: the model emits a tool call,
the client executes it here, and feeds the JSON result back as a `tool`
message.

### POST /api/web-fetch
Reads one page for the `web_fetch` tool and returns its readable text as
markdown (`lib/webfetch.js`: Mozilla Readability over a linkedom DOM, then
Turndown; pages with no article fall back to the whole body). Body
`{ "url", "maxChars"? }` (`maxChars` clamped to 1,000–50,000, default 12,000).

- `200 { "url", "finalUrl", "title", "content", "truncated", "chars", "downloadClipped" }`.
  `chars` is the full extracted length and `content` its first `maxChars`.
- `400 { "error": "url is required" }` · `502 { "error": "web fetch failed: …" }`.

Safety: the URL comes from the model, so only `http`/`https` without
credentials is fetched. Every hop, redirects included (at most 5), must
resolve to a public address: loopback, private, link-local, CGNAT, multicast
and IPv6 local ranges are refused, and the connection is pinned to the
address that was checked. Downloads stop at 5 MB and 15 s. Only HTML, XML,
text and JSON are read.

The chat clients' "web calls" setting (web chat bar number, CLI `/searches`)
counts searches and fetches together: `0` = tools off, `N` = up to N per
answer, `-1` = unlimited.
