# Mission Control API

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
| `PREFILL_PROGRESS` | `PREFILL_PROGRESS:<progress 0-1>:<cumulativeTps>:<n_tokens>:<instantTps\|empty>` | live prefill rate. Field 2 is llama.cpp's CUMULATIVE rate (n/elapsed — a running average that decays across a long prefill); field 4 is the server-derived INSTANTANEOUS rate (delta between progress lines), empty on the first point. Prefer field 4 when present. |
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
it is tokenized (quote-aware) and run verbatim, and `-m`/`--port`/`--rpc`
are synced back into the structured config. Without it, the command is
resolved from the structured fields (modelPath, build, ctx, ngl, port
required; devices/tensorSplit/rpcTarget/mmproj/mmprojOffload/spec/sampling/
argString optional). `mmprojEnabled` + `mmprojPath` emit `--mmproj PATH`;
`mmprojOffload: false` additionally emits `--no-mmproj-offload` (keep the
projector in system RAM instead of VRAM) — only for builds whose `--help`
reference lists the flag (checked via the boot-warmed cache behind
`GET /api/flags`).

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

### GET /api/profiles
`200` the document above (empty `{ "version": 3, "profiles": {} }` if none).

### POST /api/profiles
Body `{ "name", "config"?, "lastLoadedAt"? }`:

- with `config`: upsert the profile. `savedAt` is stamped server-side.
  `config.modelPath` (when present) is validated against the filesystem —
  `400 { "error": "Model path not found: ..." }` otherwise.
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

### GET /api/worker/config
`200 { "ssh", "port", "devices" }` from `dashboard.config.json`'s `rpcWorker`
block (used to seed the GUI's worker field).

### POST /api/worker/start `{worker_ssh}` · /api/worker/stop · /api/worker/status · /api/worker/logs
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
