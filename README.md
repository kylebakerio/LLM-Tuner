# LL-Dash

LL-Dash is a self-hosted control room for running llama.cpp models on your own
GPUs. It launches `llama-server` (or the optional Strata engine) on any mix of
local cards and remote RPC workers. It records the speed of every request,
whichever client sent it, and shows live hardware telemetry. It also runs speed
benchmarks and keeps a catalog of models and launch configs with their measured
results.

It has four parts:

- a Node.js server (`server4.js`, port 3000);
- a browser UI that needs no build step;
- a small Python telemetry helper (`monitor.py`);
- a terminal client (`dash-cli/`).

It is designed for one Linux machine with one operator. **Read
[Security and remote access](#security-and-remote-access) before you expose it
to a network.**

> **Status:** personal lab software, developed and used on a small number of
> machines. Expect rough edges on hardware it has not run on.

## Features

- **Launch `llama-server`** from any of several configured llama.cpp builds,
  on an ordered list of local GPUs and RPC workers. Each device can have its
  own share, and the split mode is layer or tensor. The raw command box is
  exactly what runs.
- **Saved launch profiles**, shared by the web UI and the CLI. Devices are
  saved by card as well as id, so a profile follows its card when device ids
  shift, or when it moves to another machine.
- **RPC workers.** LL-Dash starts and stops `ggml-rpc-server` on other machines
  over SSH, and by default carries RPC through an SSH forward.
- **Strata engine (optional).** Launches configs from one or more Strata
  installs, with per-launch overrides.
- **Request capture from any client.** Every request to the model gets a row:
  token counts, t/s, wall time, draft acceptance, and a hardware time series for
  that request.
- **Live telemetry** for NVIDIA and AMD GPUs, the host's CPU, RAM and network,
  and the GPUs of RPC workers.
- **History**, kept in a CSV file and in a SQLite database.
- **Speed benchmarking:** `llama-bench` runs, launch sweeps of the real server
  (including speculative decoding), and public coding suites.
- **Results catalog:** one record per model, with speed by launch config and
  context depth, history and side-by-side comparisons. GGUF files are
  identified by their content.
- **Built-in chat** with attachments, thinking control, and server-side web
  search and fetch tools.
- **A terminal client** (`dash-cli/`) with Monitor, Launch and Chat modes.
- **Remote access** through a Cloudflare tunnel, behind a password gate.
- **Optional extras:**
  - views and a run queue for an external coding-benchmark harness;
  - a separate, read-only public results site.

## Requirements

**Required**

- **Linux.** The code reads `/proc`, `/sys/class/hwmon` and `/sys/bus/pci`, and
  uses `ss` (iproute2) and `flock`.
- **Node.js 20.** This is the version it is developed on; there is no `engines`
  field. `better-sqlite3` is a native module, so `npm install` either downloads
  a prebuilt binary or builds one (that needs a C++ toolchain and Python).
- **Python 3** for `monitor.py`, standard library only.
- **One or more llama.cpp builds** that provide `llama-server`.
  - `llama-bench` is needed for the Bench tab.
  - Each RPC worker needs `ggml-rpc-server`, built from the same llama.cpp
    commit as the master.

**For GPU telemetry**

- `nvidia-smi` for NVIDIA cards, and `amdgpu_top` for AMD cards. Other GPUs can
  be launched on but show no readings.

**Optional**

| Tool | Needed for |
|---|---|
| [pm2](https://pm2.keymetrics.io/) | keeping the server running |
| `ssh` with non-interactive (key-based) login | RPC workers and worker telemetry |
| `cloudflared` | remote access |
| `gh`, logged in | the posts editor |
| a Strata install | the Strata engine |
| `evalplus`, or the Aider benchmark checkout plus Docker | the public coding suites |
| Node.js 22+ (for `wrangler`) | deploying the static public site |

## Quick start

LL-Dash keeps its runtime data **next to** the checkout, not inside it, so give
it a parent directory of its own:

```bash
mkdir -p ~/llm-lab && cd ~/llm-lab
git clone <repository-url> dashboard
cd dashboard
npm install
cp dashboard.config.example.json dashboard.config.json   # then edit it (see Configuration)
node server4.js                                          # open http://localhost:3000
```

After the first run, the layout is:

```
~/llm-lab/
  dashboard/        this repository
    logs/           device-list cache and a code stamp (small, per machine)
  logs/             created at runtime: request CSV, SQLite database, launch
                    profiles, bench transcript, derived Strata configs
  models/           optional: GGUF files or symlinks to them (scanned first)
```

To keep it running in the background, see [Under pm2](#under-pm2). For a tour
of the interface, see [docs/web-ui.md](docs/web-ui.md).

## Configuration

`dashboard.config.json` holds every per-machine setting.

- It is gitignored, and every key is optional.
- `dashboard.config.example.json` is a neutral starting point. It works
  unchanged with llama.cpp built in `~/llama.cpp/build` and models in
  `~/models`.
- If the file is missing or invalid, LL-Dash falls back to one build at
  `~/llama.cpp/build/bin/llama-server`.
- [TOPOLOGY.md](TOPOLOGY.md) ("Configuration") is the full reference.

| Key | What it sets |
|---|---|
| `pathRoots` | `{ "NAME": "path" }`: roots usable as `${NAME}` in any path here and in saved profiles. |
| `modelsRoot` | Where this machine keeps its models. It is scanned, available as `${MODELS}`, and is the base for relative model paths. |
| `llamaServerBuilds` | `[{ id, label, path }]`: the `llama-server` binaries in the Build selector. |
| `modelDirs` | More directories to scan for GGUF files. |
| `rpcWorkers` | Other machines' GPUs, by name. See [RPC workers](docs/launching-models.md#rpc-workers). |
| `strataInstalls` | Strata install directories, with the current one first. Empty means no Strata. |
| `llamaHost` | The address `llama-server` listens on. The default is `127.0.0.1`. |
| `remoteAccess` | The tunnel and password gate. See [below](#tunnel-and-password-gate). |
| `deviceNames`, `machineNames`, `modelDisplayNames`, `reliabilityNotes` | Display names and hardware notes for recorded runs. |

The example file also lists keys used only by the optional benchmark
integration. Leave those empty if you don't use it.

**Paths.**

- A leading `~` and `${NAME}` (from `pathRoots`, otherwise the environment) are
  expanded. Nothing else in a path is changed.
- An absolute path is used exactly as written.
- `tools/migrate-profile-paths.js` shows the portable spelling of an existing
  profile store.

Example (every value is a placeholder):

```json
{
  "pathRoots": { "LLAMA": "~/llama.cpp" },
  "modelsRoot": "~/models",
  "llamaServerBuilds": [
    { "id": "all",    "label": "CUDA + ROCm + Vulkan", "path": "${LLAMA}/build-all/bin/llama-server" },
    { "id": "vulkan", "label": "Vulkan only",          "path": "${LLAMA}/build-vulkan/bin/llama-server" }
  ],
  "rpcWorkers": {
    "worker1": { "ssh": "user@worker-host", "localPort": 50052, "devices": "Vulkan0" }
  },
  "remoteAccess": {
    "tunnelConfig": "~/.cloudflared/<tunnel>.yml",
    "url": "https://dash.example.com",
    "autoStart": true,
    "passwordFile": "~/.config/ai-dashboard/tunnel-password"
  }
}
```

**Where models are found.** These locations are scanned recursively, in this
order. A file reachable by more than one path is listed once.

1. `../models`
2. `/data/models` (fixed in the code; skipped if it doesn't exist)
3. the Hugging Face cache (`$HF_HOME`, else `$HUGGINGFACE_HUB_CACHE`, else
   `~/.cache/huggingface/hub`)
4. `modelsRoot`
5. each entry of `modelDirs`

Split GGUFs appear as one entry, and mmproj files are paired with their models.

**Environment variables**

| Variable | Effect |
|---|---|
| `HF_HOME`, `HUGGINGFACE_HUB_CACHE` | The Hugging Face cache to scan. |
| `STRATA_DIR` | One more Strata install, listed first. |
| `POSTS_REPO`, `POSTS_CLONE` | The posts repository (`owner/name`) and its local clone, for the posts editor. |
| `MONITOR_BIND` | `monitor.py`'s listen address. The default is `127.0.0.1`. |
| `MONITOR_PORT` | `monitor.py`'s port. The dashboard always dials 8081, so this is only for trying a second copy. |
| `SWEEP_STATE_FILE` | Where the headless sweep keeps its state. The default is `sweep-state.json` in the checkout. |

## Running it

### Ports

| Port | What | Bound to |
|---|---|---|
| 3000 | Dashboard UI and API (`server4.js`). Fixed. | all interfaces |
| 8080 | `llama-server` (default). A `--port` in the command overrides it. | `127.0.0.1`, unless `llamaHost` is set |
| 8081 | `monitor.py` telemetry | `127.0.0.1` (`MONITOR_BIND` overrides) |
| 50052 | RPC worker (`ggml-rpc-server`) on the worker; also each worker's local forward port | the worker's loopback (`link: "ssh"`) or all interfaces (`link: "direct"`) |
| 3100 | Public site (`public/server.js`, optional) | all interfaces (`PUBLIC_HOST`) |
| 3101 | Public live API (`public/live_server.py`, optional) | `127.0.0.1` |

Strata servers default to port 8095. Whenever the model server runs on a port
other than 8080, the dashboard forwards `127.0.0.1:8080` to it, for clients
that are hard-wired to 8080.

### Under pm2

`ecosystem.config.js` defines three apps:

| App | Script | What |
|---|---|---|
| `dashboard` | `server4.js` | The dashboard. Start this one. |
| `public` | `public/server.js` | The optional public results site (port 3100) |
| `live` | `public/live_server.py` | The optional live API for the static public site (port 3101) |

```bash
pm2 start ecosystem.config.js --only dashboard   # a plain `pm2 start ecosystem.config.js` starts all three
pm2 status                                       # state, PID, uptime, restart count (↺, cumulative)
pm2 logs dashboard                               # server output, including the echoed llama-server log
pm2 restart dashboard                            # e.g. after editing server4.js or lib/
pm2 stop dashboard                               # pm2 won't auto-restart an app you stopped
pm2 save                                         # so `pm2 resurrect` / `pm2 startup` brings it back
```

Each app has a crash-loop guard: `restart_delay: 2000`, `min_uptime: 5000`,
`max_restarts: 20`. If an app keeps dying within 5 s, pm2 gives up after 20
restarts.

`monitor.py` is not a pm2 app; `server4.js` starts and stops it. To run in the
foreground instead, use `node server4.js`.

### Startup and shutdown

At startup the server does the following, in order:

1. Loads the configuration.
2. Loads each build's last known device list from `logs/device-cache.json`.
   Builds with no cached list are probed later, when the GPUs are free.
3. Stops orphans left on ports 8080 and 8081 by a previous dashboard. It only
   stops a model server or `monitor.py`; nothing else is touched.
4. Starts `monitor.py`.
5. Starts the tunnel, if `remoteAccess.autoStart` is set.

On SIGINT or SIGTERM, it stops what it started: `llama-server`, `llama-bench`,
`monitor.py` and `cloudflared`.

**A restart therefore unloads a model the dashboard launched.** That covers a
pm2 restart, a crash and a manual restart. Load the model again afterwards.

The Stop button sends SIGTERM, then SIGKILL after 3 s. A server that exits
before it is ready shows its last error lines as "Launch failed".

## Security and remote access

### Default exposure

**With no tunnel running, LL-Dash has no authentication.** It assumes a trusted
machine and network.

| Component | Exposure |
|---|---|
| Dashboard (port 3000) | All interfaces, CORS `*`. The launch command is run as given, so anyone who can reach the port can **run any program as the user the dashboard runs as**. They can also start and stop processes on configured workers over SSH, and read the request history. |
| `monitor.py` (port 8081) | Loopback only (`MONITOR_BIND` overrides). It answers only the dashboard's telemetry POST, and GET returns 404. |
| `llama-server` | `127.0.0.1` by default. Setting `llamaHost` (for example `"0.0.0.0"`) exposes it, also without authentication. |
| `ggml-rpc-server` | No authentication. With `link: "ssh"` (the default), it listens on the worker's loopback only, behind the SSH forward. With `link: "direct"`, it listens on all of the worker's interfaces. |

Because the dashboard sends CORS `*`, a firewall alone is not enough. Any web
page open in a browser that can reach the dashboard, including a browser on
the same machine, can send it requests.

**Recommendations**

- Firewall port 3000 from any network you don't trust. If you set
  `MONITOR_BIND` or `llamaHost` to a non-loopback address, firewall those ports
  too.
- Don't browse untrusted sites in a browser that can reach an ungated
  dashboard. Alternatively, keep the password gate armed (see below).
- From another machine, prefer an SSH port forward
  (`ssh -L 3000:localhost:3000 <host>`) or the tunnel.

### Tunnel and password gate

`POST /api/tunnel` publishes the dashboard through Cloudflare, in one of two
ways:

- **Quick tunnel** (no account needed): runs `cloudflared tunnel --url
  http://127.0.0.1:3000` and gets a random `https://<random>.trycloudflare.com`
  URL. You supply the password in the start request; it must be at least 4
  characters.
- **Named tunnel**: set `remoteAccess.tunnelConfig` to a `cloudflared` config
  file, and `remoteAccess.url` to its public URL.
  - With `autoStart: true` and a `passwordFile` (keep that file mode 600), the
    tunnel starts with the dashboard and is retried every 60 s if it fails or
    exits.
  - Stopping it through the CLI or the API leaves it stopped until the next
    dashboard start.

**Starting a tunnel arms a password gate in front of every request.** That
includes static files, REST and SSE, and local requests as well as remote
ones, because `cloudflared` forwards from localhost and the two look the same.

- **Credentials:** send `Authorization: Bearer <password>` (CLI, scripts), or an
  `mc_session` cookie set by the gate's login page (`POST /api/tunnel/login`).
- **Unauthenticated requests** get the login page (browsers) or a `401` JSON
  response.
- **The password** is checked with PBKDF2-HMAC-SHA256 (200,000 iterations)
  against a salt generated when the tunnel starts. The dashboard never writes
  the password to disk.
- **Browser sessions** are signed tokens valid for 30 days. They survive a
  dashboard restart; the signing key lives in
  `~/.config/ai-dashboard/session-secret.json` (mode 600). Stopping the tunnel,
  or changing the password, logs every session out.
- **The login has no rate limit or lockout.** Use a long password.
- **`remoteAccess.allowIps`** lists peers that may skip the password. It
  matches the socket's remote address, never a forwarded header. Loopback
  entries are ignored, because tunnel traffic arrives from `127.0.0.1`.
- **`remoteAccess.failRedirect`** (optional) sends a browser to another URL
  after a wrong password.
- **Stopping the tunnel** drops the gate. Use `llama-cli tunnel stop`, or
  `POST /api/tunnel {"action":"stop"}`.

`cloudflared` must be on the PATH, or you can set `remoteAccess.cloudflared`.
The dashboard's shutdown handler stops it.

### The web-fetch tool

The model chooses the URLs that the chat's `web_fetch` tool reads, so the tool
is restricted:

- Only plain `http`/`https` URLs without credentials are allowed.
- Every hop, redirects included, must resolve to a public address. Loopback,
  private, link-local, CGNAT and multicast ranges are refused, and the
  connection is pinned to the address that was checked.
- At most 5 redirects, 5 MB and 15 s.
- Only HTML, XML, text and JSON are read.

## Project layout

```
server4.js               backend: HTTP + SSE on :3000; launches and supervises model servers
monitor.py               telemetry helper on 127.0.0.1:8081
index.html, script.js    the main page (no build step)
ui/                      page modules (Results, Bench views, pickers, posts editor, shared helpers)
lib/                     server modules, most pure and unit-tested
db/schema.sql            SQLite schema
dash-cli/                terminal client
public/                  public results site and its static build
bench-tools/, tools/     sweep client, depth sweep, profile and weights utilities
test/                    node:test unit tests
vendor/                  Chart.js, marked, prebuilt Tailwind CSS, inlined fonts
```

[docs/development.md](docs/development.md) has the full module list.

## Documentation

| Page | Covers |
|---|---|
| [docs/web-ui.md](docs/web-ui.md) | Each tab, both sidebars, the chat and the posts editor |
| [docs/launching-models.md](docs/launching-models.md) | Device lists, the raw command box, launch guards, profiles, device probes, builds, RPC workers, Strata |
| [docs/benchmarking.md](docs/benchmarking.md) | `llama-bench`, launch sweeps, public suites, and the optional benchmark integration |
| [docs/building-benchmark-tasks.md](docs/building-benchmark-tasks.md) | Building and maintaining tasks for a private coding benchmark: prompts, hidden tests, validation, reading early passes and fails, keeping it private |
| [docs/terminal-client.md](docs/terminal-client.md) | `dash-cli` overview ([dash-cli/README.md](dash-cli/README.md) is the full manual) |
| [docs/public-site.md](docs/public-site.md) | The public results site, its static build and posts |
| [docs/development.md](docs/development.md) | Tests, CSS and fonts, offline use, tools, HTTP API overview, project layout |
| [API.md](API.md) | The HTTP and SSE contract |
| [TOPOLOGY.md](TOPOLOGY.md) | Hardware model, profile portability, run labels, full configuration reference |

## Limitations

- **Linux only.**
- **GPU telemetry covers AMD and NVIDIA only.**
  - Fan RPM and memory temperature are AMD-only.
  - Worker telemetry over SSH is NVIDIA-only.
- **Identical cards are paired by listing order,** both across backends and in
  telemetry.
- **Ports 3000, 8080 and 8081 are fixed defaults.**
- **Some defaults still reflect the machines this was written on.** Examples:
  the fixed `/data/models` scan, and the hard-coded paths in
  `bench-tools/depth_sweep.py`. [TOPOLOGY.md](TOPOLOGY.md) ("Still
  machine-specific") has the full list.
