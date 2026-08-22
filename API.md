# Mission Control API

Contract for the HTTP + SSE surface served by `server4.js` on port 3000.
Two clients consume it today: the browser UI (`index.html`/`script.js`) and
the terminal UI (`llama-cli/`). This document is the source of truth when
adding a third client or changing a payload — update it in the same change.

Base URL: `http://localhost:3000` (the server binds all interfaces).
Auth: none (localhost tooling). A token scheme is planned for LAN use —
see `llama-cli/PLAN.md` §7.1.

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
  "launchConfig": { "modelPath": "...", "build": "vulkan-cuda", "ctx": 32768, "ngl": 99, "port": 8080, "deviceA": "CUDA0", "deviceB": "Vulkan2", "tensorSplit": 55, "argString": "" }
}
```

`launchConfig` is the structured config of the most recent `/api/start`
(null after stop) — clients can repopulate a config form from it.

### Tagged `log` values

Most `log` values are raw `llama-server` output lines (echoed for display).
Some are tagged events; clients should branch on the prefix:

| Tag | Format | Meaning |
|---|---|---|
| `PREFILL_PROGRESS` | `PREFILL_PROGRESS:<progress 0-1>:<tps>:<n_tokens>` | live prefill rate |
| `GEN_PROGRESS` | `GEN_PROGRESS:<avgTps>:<instTps>:<n_decoded>` | live generation rate |
| `CTX_LIVE` | `CTX_LIVE:<n_prompt_tokens>:<n_ctx>:<is_processing 0/1>` | live context usage from the `/slots` poll |
| `COMPLETION` | `COMPLETION:<json>` | a request finished (any client); json below |
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
  "metrics": [ { "t": 0, "gpuUtil": 98, "gpuPwr": 287, "gpuTemp": 68, "vram": 21400, "cpuUtil": 40, "netMbps": 0.4 } ],
  "detail": { "modelPath": "...", "ctx": 32768, "ngl": 99, "rpc": "no", "launchCommand": "...", "config": {} }
}
```

`runId` is unique **per request**, not per launch session.

## Launch control

### POST /api/start
Body: the structured launch config (same shape as `launchConfig` above).
Optional `rawCommand` field: when non-empty it is the source of truth —
it is tokenized (quote-aware) and run verbatim, and `-m`/`--port`/`--rpc`
are synced back into the structured config. Without it, the command is
resolved from the structured fields (modelPath, build, ctx, ngl, port
required; devices/tensorSplit/rpcTarget/spec/sampling/argString optional).

- `200 { "status": "launching" }`
- `400 { "error": "..." }` — already running, or invalid config
  (missing model, non-finite ctx/ngl, bad port, unknown build).

### POST /api/preview-command
Same body, no side effects. Returns the exact command that `/api/start`
would run: `200 { "command": "/path/llama-server -m '...' ..." }` or
`{ "command": "", "error": "..." }`. Shell-quoted, copy-pasteable.

### POST /api/stop
`200 { "status": "stopped" }`. SIGTERM, SIGKILL after 3 s.

### GET /api/models
`200 [ { "name": "x.gguf", "path": "/abs/path", "size": "20.75", "source": "local|huggingface" } ]`
(from `../models` and the HF cache).

### GET /api/builds
`200 { "builds": [ { "id": "vulkan-cuda", "label": "Vulkan + CUDA", "path": "/abs/path/llama-server" } ] }`
(from `dashboard.config.json`). `id` is the value used in every
`build` field and `?build=` query param.

### GET /api/devices?build=<id>
`200 { "devices": [ { "id": "CUDA0", "description": "NVIDIA ...", "totalMib": 15943, "freeMib": 1114 } ] }`
or `{ "devices": [], "error": "timed out|failed" }` (device enumeration
can hang on a bad eGPU link; fall back to manual entry).

### GET /api/flags?build=<id>
`200 { "flags": [ { "flags": "-c, --ctx-size N", "description": "...", "section": "general", "insertText": "--ctx-size ", "primaryFlag": "--ctx-size" } ] }`
(parsed from the build's `--help`, cached per build).

## Telemetry

### GET /api/telemetry/latest
`200 { "t": <ms epoch>, "stats": { "master": {...}, "worker": {...} } }`
(`{ "t": 0, "stats": null }` until the first sample). The server polls
`monitor.py` (:8081) at a fixed rate and caches — this endpoint never
shells out.

`master`/`worker` fields: `gpu_name`, `gpu_util` (%), `vram_used`/
`vram_total` (MB), `process_vram` (MB used by llama-server), `gpu_pwr` (W),
`gpu_temp` (°C), `gpu_throttle` (bool), `throttle_reasons` (string[]),
`ram_used`/`ram_total` (MB), `process_ram`, `cpu_name`, `cpu_util` (%),
`cpu_temp` (°C, 0 on AMD worker), `net_bytes` (cumulative),
`nvidia_smi_error`/`amdgpu_top_error` (bool).

`worker` is the local second GPU or the RPC worker; `gpu_name: "Offline"`
when absent.

### POST /api/telemetry/rate
Body `{ "ms": 250..5000 }` → `200 { "ok": true, "ms": 1000 }`.

## Request history (all from `logs/benchmarks.csv`)

### GET /api/logs/recent?limit=N
`200 { "rows": [ { "timestamp", "runId", "model", "transport", "promptTps", "genTps", "promptTokens", "genTokens", "wallTime", "draftAcceptRate", ..., "aborted", "detail": { "modelPath", "ctx", "ngl", "argString", "launchCommand", "loadTime", "gpuUtil", "gpuPwr", "gpuTemp", "cpuUtil", "vram", "ram", "wGpuUtil", ..., "config": {...} } } ] }`
(oldest→newest; null for missing numeric fields).

### GET /api/logs/samples?runId=<run_id>
`200 { "samples": [...] }` — the GPU sample series for that request,
only available while the request is in the in-memory ring buffer
(recent requests); older ones return `{ "samples": [] }`.

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

### POST /api/worker/start `{worker_ssh}` · /api/worker/stop · /api/worker/status · /api/worker/logs
Manage the remote RPC worker container via SSH + docker compose.
