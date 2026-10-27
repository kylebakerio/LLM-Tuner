# Development

## Tests

```bash
npm test                    # node --test test/  (the dashboard's unit tests)
cd dash-cli && npm test     # the terminal client's tests
```

**Requirements.** The tests need no GPU, no running dashboard and no network.
Some of them use:

- temporary SQLite databases, through `better-sqlite3`;
- `python3`, for the live-API test, which is skipped without it;
- `git`, in a temporary directory.

**Optional data.** A few tests use local data when it exists and skip
otherwise.

**Older Node versions.** If `node --test <dir>` does not pick up the test files
on your Node version, use `node --test test/*.test.js` instead.

**Live test.** `dash-cli/test/live-cycle.sh` runs against the **live**
dashboard and stops the loaded model. See
[terminal-client.md](terminal-client.md#notes).

## CSS and fonts

`vendor/tailwind.css` is a prebuilt, purged Tailwind build. **A Tailwind class
used for the first time does nothing until you rebuild:**

```bash
npm install           # once: pulls in the tailwindcss + font dev dependencies
npm run build:css     # regenerates vendor/tailwind.css
npm run build:fonts   # regenerates vendor/fonts.css (Inter + JetBrains Mono, inlined)
```

- **Scanned files:** `index.html`, `script.js`, `ui/**` and `public/**`.
- **Theming:**
  - `tailwind.config.js` remaps the `gray`/`indigo` palettes and the font
    stacks.
  - `tailwind.src.css` holds:
    - the design tokens (`:root` CSS variables);
    - base styles;
    - shared components: `.card`, `.btn`, `.chip`, `.nav-tab`, `.seg-btn`,
      `.tile` and `.side-group`.
  - `ui/shared/theme.js` applies the same tokens to Chart.js.
- **Committed output.** The built CSS and fonts are committed, so users never
  need to run these steps.

## Offline use

Chart.js, marked, the CSS and the fonts are all vendored under `vendor/`, so the
UI loads no CDN assets and works without internet access.

Only these features reach the internet:

- the Hugging Face model search, which runs in the browser against
  `huggingface.co`;
- the chat's web search and web fetch, which run on the server;
- the public suites' own downloads.

## Assets and reloading

The page loads `script.js`, `vendor/` and the `ui/` modules under content-hashed
`/v/<hash>/` URLs, so reloading the page always picks up edited files.

Changes to `server4.js` or `lib/` need a dashboard restart. A restart unloads
the model; see the [README](../README.md#startup-and-shutdown).

## Tools

- `tools/migrate-profile-paths.js` shows, and with `--write <new-file>` writes,
  a portable version of the profile store.
- `tools/weights-registry.js` builds `weights-registry.json`, the cache of GGUF
  content fingerprints, from the paths recorded in the database. With `--hf` it
  also looks files up on Hugging Face.
- `tools/build-fonts.js` is the script behind `npm run build:fonts`.
- `bench-tools/sweep-submit.py` and `bench-tools/depth_sweep.py`: see
  [benchmarking.md](benchmarking.md).

## HTTP API overview

Everything the UI and the CLI do goes through HTTP and SSE on port 3000.
[API.md](../API.md) is the contract: payloads, status codes and examples.

| Area | Main routes |
|---|---|
| State stream | `GET /api/status` (SSE). `?ticks=1` adds per-second telemetry events. |
| Launch | `POST /api/start`, `POST /api/stop`, `POST /api/preview-command`, `GET /api/builds`, `GET /api/devices`, `GET /api/topology`, `GET /api/flags` |
| Models | `GET /api/models`, `GET /api/models/catalog`, `GET /api/model?key=` |
| Profiles | `GET`/`POST /api/profiles`, `DELETE /api/profiles/<name>` |
| Telemetry | `GET /api/telemetry/latest`, `GET /api/telemetry/range`, `POST /api/telemetry/rate`, `GET /api/slots` |
| History | `GET /api/logs/recent`, `/api/logs/range`, `/api/logs/samples`, `/api/logs/summary`, `/api/logs/csv` |
| Bench | `/api/bench/*` (llama-bench), `/api/sweep/*` (headless sweep), `/api/suite/*` (public suites) |
| Workers | `GET /api/worker/config`, `POST /api/worker/{start,stop,status,logs}` |
| Strata | `GET /api/strata/configs`, `POST /api/strata/preview` |
| Chat and tools | `POST /api/chat`, `POST /api/web-search`, `POST /api/web-fetch` |
| Remote access | `GET`/`POST /api/tunnel`, `POST /api/tunnel/login` |

These newer routes are not yet written up in API.md:

- `/api/telemetry/range`, `/api/logs/range`
- `/api/sweep/*`, `/api/suite/*`
- `/api/master/logs`
- `/api/posts/*`

Some examples:

```bash
curl -s localhost:3000/api/models | jq -r '.[].name'
curl -N localhost:3000/api/status                       # SSE frames: state, log lines, completions
curl -s -X POST localhost:3000/api/preview-command \
     -H 'Content-Type: application/json' -d @launch.json  # the exact command /api/start would run
```

`POST /api/chat` is a thin proxy. POST an OpenAI chat-completions request body
to it, and the model's response streams back, including through the tunnel.
Every request is recorded, whether it arrives through this proxy or directly
on the model's port.

## Project layout

```
server4.js               the backend: HTTP + SSE on :3000, launches and supervises
                         llama-server / Strata, parses logs, records requests, runs
                         llama-bench, RPC workers over SSH, tunnel and gate
monitor.py               telemetry helper on 127.0.0.1:8081 (nvidia-smi, amdgpu_top,
                         hwmon, /proc; RPC workers over ssh)
index.html, script.js    the main page (no build step)
ui/                      page modules: models/ (Results), benchmarks/, leaderboards/,
                         livechat/, autoqueue/, modelpicker/, profilepicker/, posts/,
                         topology/, shared/
lib/                     server modules (most are pure and unit-tested), e.g.
  devices.js               ordered device list and RPC workers
  topology.js              physical-card model of the machine; profile fit; launch gate
  deviceprobe.js           when --list-devices may run; device-list cache
  gpusafety.js             what startup cleanup and probes may touch
  launchguard.js           busy-card check for /api/start
  paths.js                 ~ and ${NAME} path expansion
  modelscan.js, mmproj.js  GGUF discovery and mmproj pairing
  models.js                the Results catalog (catalogcache.js / catalogworker.js keep it prebuilt)
  weightsid.js             GGUF content fingerprints
  db.js, history.js        SQLite access; CSV + SQLite history merge
  reqsamples.js            per-request telemetry series
  telemetry.js, telemetryhistory.js   readings -> devices; 6 h telemetry ring buffer
  slots.js, tps.js         live rates from /slots and other sources
  strata.js, stratalog.js  Strata configs/overrides; Strata log parsing
  sweep.js, suites.js      headless launch sweep; public suites
  webfetch.js              the web_fetch tool
  gate.js                  tunnel login responses
  publicdata.js, publiclive.js   what the public site may show; its live files
  postsrepo.js             posts editor (git + gh)
  ... plus modules for the optional benchmark integration
db/schema.sql            SQLite schema
dash-cli/                terminal client (its own package.json and tests)
public/                  public site: server.js, build-static.js, publish-static.js,
                         preview-static.js, live_server.py, posts.js, staticsite.js
bench-tools/             sweep-submit.py (headless sweep client), depth_sweep.py
tools/                   migrate-profile-paths.js, weights-registry.js, build-fonts.js
test/                    node:test unit tests and fixtures
vendor/                  Chart.js, marked, prebuilt Tailwind CSS, inlined fonts
ecosystem.config.js      pm2 apps
dashboard.config.example.json   starting point for dashboard.config.json
API.md, TOPOLOGY.md      API contract; hardware model and configuration reference
docs/                    these pages
```

## Limitations in detail

- **Linux only.** The code relies on `/proc`, `/sys/class/hwmon`,
  `/sys/bus/pci`, `ss` and `flock`.
- **GPU telemetry covers AMD and NVIDIA only.**
  - Fan RPM and memory temperature are AMD-only; NVIDIA reports fan percent.
  - Worker telemetry over SSH is NVIDIA-only.
- **Identical cards are paired by order.** Across backends and in telemetry, the
  k-th card of a model is assumed to be the same physical card.
- **An integrated GPU listed by a backend counts as a card.** It starts unticked
  in the device table.
- **"Busy" is a telemetry threshold.** For the probe rule, a card is busy at
  3 GB of VRAM in use or 30% utilization. Nothing is read from the engines.
- **Some defaults reflect the machines this was written on:**
  - `/data/models` is always scanned;
  - `bench-tools/depth_sweep.py` has hard-coded paths and devices;
  - parts of the optional benchmark integration assume a particular local
    setup.

  [TOPOLOGY.md](../TOPOLOGY.md) ("Still machine-specific") has the full list.
