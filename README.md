# Mission Control

A single-host dashboard for running and measuring llama.cpp models on local
GPU(s), with an optional remote RPC worker. It launches `llama-server`
natively, watches it over an SSE stream, captures per-request performance for
*any* client that hits the model's OpenAI endpoint (this dashboard's own
chat, opencode, curl — anything), benchmarks hardware with `llama-bench`, and
logs every request to CSV for later comparison.

It serves the UI and all `/api/*` endpoints on **port 3000**. Run it under
pm2 (see below) or `node server4.js` in the foreground.

## Files

| File | What it is |
|---|---|
| `server4.js` | The backend: HTTP server + SSE state stream. Spawns/stops `llama-server`, parses its log lines (model status, per-request timing, fatal errors), writes the benchmark CSV, spawns `monitor.py`. |
| `monitor.py` | Telemetry child process on **port 8081**: GPU/CPU/VRAM/power/temp via `nvidia-smi`/`amdgpu_top` — for this machine, a second local GPU, or a remote worker over SSH. |
| `index.html` / `script.js` | The frontend. Single page, no build step, fully offline (see below). |
| `dashboard.config.json` | User-editable and gitignored: the `llamaServerBuilds` list (id/label/path) behind the "Build" selector. See `dashboard.config.example.json`. Missing/invalid file falls back to the built-in default build. |
| `ecosystem.config.js` | pm2 config (see below). |
| `vendor/` | Vendored Chart.js / marked / prebuilt Tailwind CSS (offline support). |
| `logs/` | Created at runtime: `benchmarks.csv` (one row per completed request) + `bench-history.log` (bench/sweep transcript, tail reloaded on boot). |

## Ports

| Port | What |
|---|---|
| 3000 | Dashboard UI + API |
| 8080 | `llama-server` (default; a `--port` in the raw command box overrides it, and the telemetry follows) |
| 8081 | `monitor.py` telemetry |
| 50052 | Remote RPC worker (llama.cpp RPC) |

Models are picked from top-level `.gguf` files in `../models` (next to this
directory) or from the local Hugging Face cache
(`~/.cache/huggingface/hub`, or `$HF_HOME`/`$HUGGINGFACE_HUB_CACHE`).

## UI tabs

- **Interactive** — the dashboard's own chat client against the launched
  model: image attach (paths or file picker), a per-request thinking level
  (`template default` / `on` xhigh/medium/low / `off`, via
  `chat_template_kwargs`), a show/hide-thinking display toggle, and an
  "allow web search" tool (keyless DuckDuckGo, run server-side).
- **Monitor** — per-request telemetry, session-only. Capture is
  *client-agnostic*: the server parses `llama-server`'s own `print_timing`
  lines, so a request from any client gets a row (prompt/gen tokens + tps,
  wall time, load time, draft-acceptance stats) plus an "omni" graph of GPU
  power/temp/utilization/VRAM sampled over the request's life.
- **History** — the persisted view: recent rows and aggregate stats
  (best/avg prefill, gen, wall time; the last run's full config) from
  `logs/benchmarks.csv`, filterable by model + transport, with a CSV download.
- **Bench** — `llama-bench` hardware runs (single or matrix; the matrix queue
  lives *server-side*, so it keeps running if you close the tab) and sweeps
  that bench the real `llama-server`, including the speculative-decoding
  stack that `llama-bench` can't exercise.

Launch settings live in the left sidebar: model, build, ctx/ngl, device A/B
(auto-detected on load, manual override available), tensor split, KV cache
types, speculative decoding, sampling params, and a Flag Reference popover
(parsed from the selected build's `--help`) that click-inserts flags. Saved
setups persist as launch profiles in the browser.

## Launching: local GPU(s) + optional RPC worker

The master (`llama-server`) always launches natively now -- there's no more
Docker-vs-local mode choice. `dashboard.config.json`'s `llamaServerBuilds`
picks which compiled binary to run (e.g. Vulkan-only vs. a combined
CUDA+Vulkan build), and up to two local devices (GPU A / GPU B) can be
selected for a split, both detected automatically on page load.

**The raw command box is the source of truth.** The structured fields seed
the box (via the preview endpoint) on every change, but whatever text is in
the box at Boot time is what gets tokenized and run. `-m`, `--port`, and
`--rpc` in the box are synced back into the server-side launch config, so
the CSV row, the `/slots` poll, and worker telemetry all use the values that
actually ran. Launches are validated server-side (model path present, finite
ctx/ngl, port 1–65535, a valid build) — a bad launch returns a clean error
in the UI instead of leaving the dashboard stuck in "starting".

RPC Worker is a separate, optional toggle (off by default) that adds a remote
`llama.cpp` RPC worker as a second compute target alongside your local GPU(s).
Enabling it forces GPU B back to "None" -- the split is always exactly 2-way
(this machine vs. the worker), not a 3-way local+local+remote split.

**RPC needs a local build compiled with `-DGGML_RPC=ON`** (the Vulkan
`build/` has it as of 2026-09-13; `build-cuda-vulkan` does not):

```bash
cmake -B build -DGGML_RPC=ON
cmake --build build --config Release -j$(nproc) --target llama-server ggml-rpc-server llama-bench
```

**The worker runs a bare `ggml-rpc-server` binary -- no Docker.** It's
configured by the `rpcWorker` block in `dashboard.config.json` (`ssh`,
`port`, `binary`, `devices`, `logFile`; see the example file). The RPC Worker
box's Start/Stop/Status/Logs buttons (and dash-cli's `w`) SSH to the worker
and run `setsid nohup <binary> -H 0.0.0.0 -p <port> -d <devices>`,
`pkill -x`, `pgrep -x`, and `tail` on the log file. SSH must work
non-interactively (`BatchMode=yes`) for the `user@host` in the worker field.

The worker binary must speak the same RPC protocol major version (and a
minor version no newer) as the master -- build it from the **same llama.cpp
commit**. The worker laptop has no build toolchain, so it's built here as a
portable binary (ggml linked statically; still needs the system libstdc++,
libgomp and libvulkan) and copied over:

```bash
cmake -B build-rpc-worker -DGGML_VULKAN=ON -DGGML_RPC=ON -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release \
  -DVulkan_GLSLC_EXECUTABLE=/home/kyle/Downloads/1.4.357.0/x86_64/bin/glslc
cmake --build build-rpc-worker -j$(nproc) --target ggml-rpc-server
scp build-rpc-worker/bin/ggml-rpc-server laptop:llama-rpc/
```

(`GGML_NATIVE=OFF` because the worker's CPU differs from this one; the
explicit `glslc` because miniconda's older `glslc` on PATH can't compile the
coopmat2 shaders.) The worker needs only the Vulkan loader and the GPU
driver's ICD. Keep `rpcWorker.devices` pinned to one device: by default
`rpc-server` serves *every* non-CPU device, which would add extra RPC
devices and break the 2-way `-ts`.

**Device list is pinned when RPC is on.** With GPU A set, `resolveLaunchCommand`
emits `--rpc host:port ... -dev <GPU A>,RPC0` (RPC devices are named `RPC<n>`
by ggml-rpc, numbered across all `--rpc` servers; `--rpc` must come before
`-dev`), so `-ts N,M` always maps N to the local GPU and M to the worker.
`llama-server --rpc host:port --list-devices` shows the names. RPC together with a local GPU B (3-way split) is still
unsupported -- the GUI forces GPU B to "None" when RPC is on.

`ggml-rpc-server` has no authentication; it listens on the LAN while running.
Stop it when you're done.

## What stops a running model server

Only genuinely fatal log lines stop the server: `failed to fit params to free
device memory`, `llama_server: fatal error`, `segfault`, `out of memory`
(case-insensitive). Non-fatal lines that merely *contain* `error:` or
`abort` — client disconnects, per-request HTTP errors — are echoed to the
log but ignored; an earlier substring check would have killed a healthy model
over a single bad client request. A process that exits on its own is handled
by the normal close/shutdown path either way. The Stop button sends SIGTERM
and escalates to SIGKILL after 3 seconds for a process that ignores it.

## Orphan cleanup on startup

At boot the dashboard `fuser -k`s whatever is holding **8080** and **8081**
before it starts its own processes. This recovers from a previous dashboard
crash that left an orphaned `llama-server`/`monitor.py` behind — which would
otherwise block the next launch with EADDRINUSE. The flip side: restarting
the dashboard while a model is *deliberately* running kills it too, so
expect to hit "Boot Cluster" again after any restart (pm2 or manual).

## Remote access (Cloudflare tunnel + password gate)

The sidebar's **Remote access (Cloudflare tunnel)** toggle (or
`POST /api/tunnel`) publishes the dashboard to a random
`https://xxx.trycloudflare.com` via a Cloudflare quick tunnel
(`cloudflared tunnel`, no account) and arms a **hard password gate on all
traffic** at the same time. While it's up:

- a **browser** can open the live web dash at the tunnel URL — it lands on a
  login page, and the password sets an `mc_session` cookie;
- a **remote CLI** can reach the local backend:
  `llama-cli -s https://xxx.trycloudflare.com --token <password>`
  (the CLI probes the gate and prompts for the password, or takes
  `--token`/`MC_TOKEN`).

The gate is **global**, not just for tunnel traffic: cloudflared forwards
from localhost, so tunnel and local requests are indistinguishable — while
the tunnel is up, *every* request (including your own local browser after a
refresh) must carry `Authorization: Bearer <password>` or the session
cookie. The only unauthenticated response is the gate page itself. Stopping
the tunnel (sidebar, `llama-cli tunnel stop`, or restarting the dashboard)
drops the gate and local access returns to normal.

Security notes: the password is held in server memory only (PBKDF2 + a
random per-boot salt) — **a dashboard restart revokes the tunnel, the gate,
and every session**, and the URL changes on every start. A failed tunnel
start clears all gate state, so it can never leave you locked out.
`cloudflared` must be on the host's `PATH`; the dashboard's shutdown handler
kills the cloudflared child on SIGINT/SIGTERM. See `API.md`
("Remote access (tunnel gate)") for the exact endpoints.

## Offline / no external dependencies

The frontend used to load Tailwind, Chart.js, and marked from public CDNs, so
the dashboard wouldn't render without internet access. Those are now vendored
locally under `vendor/` (`vendor/chart.js`, `vendor/marked.min.js`,
`vendor/tailwind.css`) and referenced from `index.html` via relative paths, so
the site works fully offline once served by `server4.js`. (The one
internet-reachable feature is the tunnel's keyless DuckDuckGo web search,
used only when a chat enables the web-search tool.)

`vendor/tailwind.css` is a pre-built, purged stylesheet (via the Tailwind CLI,
config in `tailwind.config.js`) rather than the Tailwind CDN's in-browser JIT
compiler. If you add new Tailwind classes to `index.html` or `script.js`,
rebuild it:

```bash
npm install        # one-time, pulls in the tailwindcss dev dependency
npm run build:css  # regenerates vendor/tailwind.css
```

This build step needs internet/npm; the resulting `vendor/tailwind.css` is
committed so end users never need to run it themselves.

## Running the dashboard under pm2

`server4.js` is the dashboard backend. It's the process that spawns the
master `llama-server` directly (no Docker — the master has been a native
launch since the refactor), reaches the remote worker over SSH (Docker
compose on the *worker* machine), spawns `monitor.py` as a child, and serves
the SSE state stream + HTTP API the UI depends on. Because a crash in this
process used to take the whole dashboard down until someone manually
restarted it (see `dashboard-bugs1-analysis.md` item 13), it now runs under
[pm2](https://pm2.keymetrics.io/), a Node process manager that auto-restarts
it if it ever dies.

`monitor.py` is not managed separately — `server4.js` spawns it on startup
and kills it on shutdown (along with any running `llama-server` and bench
process), so a single pm2 entry for `server4.js` covers everything.

### Config

Process settings live in `ecosystem.config.js`:

```js
module.exports = {
  apps: [{
    name: 'dashboard',
    script: 'server4.js',
    cwd: __dirname,
    restart_delay: 2000,   // wait 2s between restart attempts
    max_restarts: 20,      // give up after 20 restarts within min_uptime windows (crash-loop guard)
    min_uptime: 5000,      // must stay up 5s to count as a stable start
    autorestart: true
  }]
};
```

`max_restarts`/`min_uptime` together are a crash-loop guard: if something is
broken badly enough that the process dies within 5s of every restart, pm2
gives up after 20 attempts instead of restart-looping forever.

### Common commands

Run these from this directory (`/home/kyle/AI/experiment-1/dashboard`).

| Command | What it does |
|---|---|
| `pm2 start ecosystem.config.js` | Start the dashboard (first time, or after a full stop) |
| `pm2 status` | Show whether it's online, its PID, uptime, and restart count (`↺`) |
| `pm2 logs dashboard` | Tail stdout/stderr live (this is where `handleLogs()`'s echoed llama-server output shows up) |
| `pm2 restart dashboard` | Manually restart it (e.g. after editing `server4.js`) |
| `pm2 stop dashboard` | Stop it — pm2 will **not** auto-restart after an explicit stop |
| `pm2 delete dashboard` | Remove it from pm2's process list entirely |
| `pm2 save` | Snapshot the current process list to `~/.pm2/dump.pm2`, so `pm2 resurrect` (or `pm2 startup` + a reboot) can bring it back |

A restart via pm2 (or a crash it recovers from) does **not** preserve
in-flight model state — if a model was loaded, you'll need to hit "Boot
Cluster" again in the UI afterward, and the orphan cleanup on startup (above)
will have already reaped whatever was holding 8080. pm2 only guarantees the
dashboard backend itself comes back up; it doesn't remember or reissue your
last `/api/start` config.

### Checking restart history

The `↺` column in `pm2 status` is a cumulative restart counter for the
process's whole lifetime (not just since the last boot) — a non-zero count
after leaving it running unattended (e.g. overnight) tells you it crashed
and recovered at least that many times, worth cross-referencing against
`pm2 logs dashboard --lines 500` (or the raw log files under `~/.pm2/logs/`)
to see what actually happened.

### Removing pm2 management

If you want to go back to running it directly:

```bash
pm2 stop dashboard
pm2 delete dashboard
node server4.js   # now runs in the foreground, no auto-restart
```
