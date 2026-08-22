# llama-cli v2 — plan: a btop-quality TUI for Mission Control

Status: proposal. Written 2026-08-22 after a full read of `llama-cli/`
(~590 lines), `server4.js` (2265 lines), `monitor.py`, and the CSV/bench
history system.

## 1. Verdict

**Rewrite the CLI, upgrade the backend.**

The new CLI is a terminal *client* of the dashboard backend — the same
relationship the browser UI already has with `server4.js`. The backend
stays the single control plane (it spawns/parses `llama-server`, owns
`monitor.py` and the `llama-bench` queue, writes `benchmarks.csv`); the TUI
and the web UI become two clients of one API + one SSE stream.

This is exactly the "package the backend to work for both" hunch — and the
good news is the backend is *already* packaged that way. `server4.js` is a
plain HTTP server on :3000 with ~30 endpoints and an SSE state stream; the
browser UI is just `fetch` + `EventSource` against it. What's actually
missing to make that a real platform is small and listed in §7: optional
auth, one new endpoint, an SSE heartbeat, and an API contract doc. The big
piece of work is the TUI itself, which is new either way.

Why this path over the alternatives is spelled out in §2.

## 2. The three paths, what each entails

### Path A — upgrade the existing CLI in place

Keep `cli.js`/`lib/*`, extend the hand-rolled ANSI renderer into a mode
system, add chat/bench/history features on top of it.

- Entails: rebuilding `lib/tui.js` into a multi-mode framework on raw
  `keypress` handling (the exact code that feels crude); fixing the
  menu raw-mode bug (ISSUES.md #4); adding a form UI, a streaming chat
  parser, a bench runner, and a CSV reader by hand; keeping the CLI as its
  own `llama-server` spawner with its own unverified log parser
  (ISSUES.md #5) so it works while diverging from the dashboard's view of
  the same server.
- Cost: high effort on the TUI, and you keep the parts that were never
  satisfying. Every dashboard feature still has to be re-built and kept in
  sync manually. History (req 6) means re-implementing CSV persistence in
  the CLI, creating a second, divergent history.
- Verdict: **worst of both.** The renderer and key handling are the
  load-bearing walls of the crudeness; adding five modes on top doesn't
  raise the ceiling.

### Path B — standalone rewrite (CLI owns the processes, like today)

A from-scratch TUI that spawns `llama-server` + `monitor.py` itself and
re-implements everything server-side.

- Entails: porting the substance of `server4.js` into the CLI —
  `buildLlamaArgs`/`resolveLaunchCommand` (config→command, ~120 lines of
  fiddly flag logic), the fatal-line detector, the `print_timing` parser
  (client-agnostic capture, ~200 lines), the CSV writer + schema, the
  llama-bench matrix queue, the `--help` flag parser, worker SSH control.
  ~1500 lines of backend logic, then the TUI on top.
- Cost: **very high, and permanent.** Two sources of truth for benchmark
  data (CLI's CSV vs the dashboard's CSV) — requirement 6 ("view the data
  historical runs produced") becomes "which history?". Every future
  dashboard feature is a second port. The only scenario that justifies it:
  the CLI must work when the dashboard is down, or on a machine without it.
  (The dashboard runs under pm2 with auto-restart, so "down" is a rare,
  loud, self-healing state.)
- Verdict: only if standalone is a hard requirement. It isn't, given the
  dashboard is the tool of record and the CLI lives on the same box.

### Path C — TUI client to the dashboard backend (recommended)

Rewrite the CLI as a btop-style TUI that talks to `server4.js`.

- Entails: a new ink/React TUI with five modes; a small HTTP+SSE client
  module; profile storage (kept at `~/.llama-cli/profiles.json`, schema
  upgraded); a client-side prompt-sweep loop for benchmark lines; the
  §7 backend additions (auth, `/api/logs/runs`, heartbeat, API doc).
- Cost: **moderate.** The TUI is new work, but each of the six required
  features is a thin wrapper over an endpoint that already exists plus a
  screen. Parity with the dashboard becomes structural: when the dashboard
  gains a feature, the CLI wraps one more endpoint.
- Trade-off: the CLI needs the dashboard running. Mitigation is a first-
  class error state ("dashboard offline — `pm2 start ecosystem.config.js`")
  with auto-reconnect; pm2 already resurrects it.
- Usability: this is the most usable option, and it's the only one where
  "usable remotely" (your point) comes for free — see §8.

**Recommendation: Path C.** Upgrade or rewrite, answered concretely:
*rewrite the client, upgrade the server.*

**Build order (owner decision, 2026-08-22):** Monitor and Launch are the
first priorities; everything else is a later phase. The milestones in §9
are organized accordingly: Phase 1 = M0–M2 (backend basics, TUI shell +
Monitor, Launch flow with minimal config + profiles). Chat, Bench, and
History ship in later phases without any rework in Phase 1 — the mode
router, SSE client, and store are built to be mode-agnostic from day one.

## 3. What exists today (baseline)

| File | Lines | Role | Fate |
|---|---|---|---|
| `cli.js` | 202 | commander entry, model scan, spawn lifecycle | retire |
| `lib/tui.js` | 162 | single-screen ANSI monitor (sparklines, bars) | retire |
| `lib/menu.js` | 144 | arrow-key launcher (broken raw-mode, ISSUES #4) | retire |
| `lib/parser.js` | 117 | `print_timing` log parser (unverified, ISSUES #5) | retire — server already parses and broadcasts `COMPLETION` events |
| `lib/telemetry.js` | 98 | polls `monitor.py`:8081 (5s, README says 500ms, ISSUES #3) | retire — server polls `monitor.py` and caches `/api/telemetry/latest` |
| `lib/profiles.js` | 65 | `~/.llama-cli/profiles.json`, `{model, args}` only | **rewrite** (v2 schema, same location) |

Feature gaps vs the dashboard that reqs 1–6 are really about:

- no build selector (always build #1), no multi-GPU/RPC, no device detect
- profiles are just `{model, args}`; `args.split(/\s+/)` breaks quoted
  values (ISSUES #7); no flag reference, no preview of the resolved command
- no chat, no bench of any kind, no persistence, no history
- 5s telemetry cadence, no reconnect/error states, one screen total

## 4. Target architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────────────────┐
│  llama-cli v2 (new TUI)     │   HTTP  │  server4.js — Mission Control (:3000)    │
│  ink/React on Node 20       │◄───────►│  • REST /api/*  models, builds, devices, │
│                             │   SSE   │    flags, logs, bench, start/stop, worker│
│  modes:                     │◄────────│  • GET /api/status — SSE state stream    │
│   1 Monitor   2 Config      │         │    (state, model, tagged log lines,      │
│   3 Chat      4 Bench       │         │     PREFILL/GEN_PROGRESS, CTX_LIVE,      │
│   5 History                   │         │     COMPLETION, BENCH)                  │
└─────────────────────────────┘         │  • spawns+parses llama-server            │
        │                               │    (log → CSV row + COMPLETION broadcast)│
        │  HTTP, chat only              │  • spawns monitor.py (:8081)             │
        ▼                               │  • llama-bench runner + server-side queue│
┌─────────────────────────────┐         └──────────────────────────────────────────┘
│  llama-server (:8080)       │                        │
│  OpenAI-compatible endpoint │                        ▼
└─────────────────────────────┘         logs/benchmarks.csv · bench-history.log
```

Principles:

1. **The CLI spawns nothing and owns no state.** Process lifecycle, log
   parsing, CSV persistence, and the bench queue all stay server-side. The
   TUI's "kill server" is `POST /api/stop` (SIGTERM→SIGKILL escalation is
   already implemented server-side); its "history" is the CSV the server
   writes. One source of truth.
2. **Chat is the one direct connection**: it POSTs to
   `llama-server:8080/v1/chat/completions` (stream) — exactly what the
   dashboard's Interactive tab does. The server's client-agnostic capture
   still records that request to CSV and broadcasts a `COMPLETION` event,
   so chat stats and monitor telemetry line up automatically.
3. **The browser UI is untouched.** It remains client #1; the TUI is
   client #2. Nothing in the plan changes web behavior (except the additive
   §7 items, all backward-compatible).

### TUI tech: ink (React for the terminal)

You've done web dev your whole life — ink is the reason this is a
reasonable project for you: JSX components, hooks, state, the same mental
model as a small single-page app, rendering to a terminal instead of a
DOM.

| Option | Why not (or why) |
|---|---|
| **ink 5 + React 18** | ✅ recommended. Component model, `useInput`/`useStdout` hooks, ecosystem (`ink-text-input`, `ink-select-input`, `ink-table`, `ink-spinner`). 2 Hz updates are trivially fine if sections are memoized. |
| blessed / blessed-contrib | Older callback-style API; making it feel btop-grade means fighting the framework. |
| Ratatui (Rust) | The best raw feel, but a second language, zero code sharing with the Node backend, 2× maintenance. Not worth it here. |
| Keep hand-rolling ANSI | This is the part that was never satisfying. Retire it. |

Deps: `ink`, `react`, `ink-text-input`, `ink-select-input`, `ink-table`,
`ink-spinner`, `commander` (kept, for global flags + a few non-TUI
subcommands). Node 20 (installed; native `fetch`). No build step — ink
works fine from plain CJS/ESM source; keep it dependency-light like the
rest of this repo.

## 5. TUI conventions (btop-style)

These are the norms btop/glances/htop share; the plan standardizes on them
so the tool "feels" right:

- **Modes**: `1`–`5` (and `Tab`) switch modes; `Esc` closes overlays /
  goes back; `?` opens a keymap overlay for the current mode; `Ctrl-C` or
  `q` quits the TUI (the *server* keeps running — lifecycle is the
  backend's, not the viewer's; a confirm prompt appears only while a
  generation/bench is in flight).
- **Selection**: up/down (or j/k) + `Enter`; type-ahead fuzzy filter in
  lists (pressing `/` focuses the filter, btop-style).
- **Status bar** (bottom, always): `1 Monitor | 2 Config | 3 Chat |
  4 Bench | 5 History` with the active tab highlighted · model name +
  state (stopped/loading/running) · port · session uptime · connection
  dot (SSE live / reconnecting / offline) · mode-specific key hints.
- **Coloring**: dim labels, bold section headers, green→yellow→red
  thresholds on bars (same as the current `bar()` — port it), throttle
  badges (THERM/POWER) as today. Respect `NO_COLOR` and 256-color.
- **Responsive**: layout recomputes from `stdout.columns/rows` (ink's
  `useStdout`); 80×24 must be usable; sections drop in priority order
  (log tail first, then system, then second GPU) rather than overflowing.
- **Cadence**: 2 Hz render tick; SSE events trigger immediate targeted
  updates; memoized sections so a tick never re-renders the whole tree.
- **Error states are screens, not toasts**: dashboard offline, model
  loading, model crashed, no model loaded — each gets a full-panel state
  with the exact next action (e.g. `pm2 start ecosystem.config.js`).

## 6. The six requirements, specified

### 6.1 Req 3 first — Monitor mode (default, the btop screen)

**Data flow** (all from the backend; the TUI computes nothing the server
doesn't already know):

| Source | Gives |
|---|---|
| `GET /api/status` (SSE) | `state`, `model`, `isRpc`, `launchCommand`, `launchConfig`, `loadStartTime`/`finalLoadTime`, tagged log lines: `PREFILL_PROGRESS:<progress>:<tps>:<ntok>`, `GEN_PROGRESS:<avg>:<inst>:<n>`, `CTX_LIVE:<used>:<total>:<busy>`, `COMPLETION:<row-json>`, `BENCH:<line>` |
| `GET /api/telemetry/latest` (poll, default 1000 ms) | latest `monitor.py` sample (server already polls :8081 and caches — zero extra `nvidia-smi` cost); `POST /api/telemetry/rate {ms}` sets cadence |
| `GET /api/logs/active-samples` (poll, only while a request is in flight) | GPU power/temp/util sample series for the in-flight request (drives the live rolling graph) |
| `GET /api/logs/recent?limit=N` (on mode entry) | backfill the completed-requests table |

The TUI keeps rolling buffers (~240 points ≈ 2 min at 2 Hz) for
sparklines — same pattern as the current `telemetry.js`, smaller.

**Screen** (sketch, real layout responsive):

```
 Llama CLI — Qwen3.6-35B-A3B  [running · :8080 · up 00:14:32] ●sse ─────────────────────
 GPU 0 · NVIDIA GeForce RTX 4090
   util   ▓▓▓▓▓▓▓▓░░░░░░░░░░  51%   ▁▁▃▅▇▆▅▃▁▁▁▃▅▇
   vram   ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  21.4/24.0 GB (89%)  model 20.8 · other 0.6
   power  287 W / 350 W          temp 68°C
 GPU 1 · worker (rpc 192.168.1.125)
   ...
 TOKENS
   prefill  452.1 t/s ▁▃▅▇▇▅▃▁        gen  21.3 t/s (inst 19.8) ▁▁▂▂▃▃▃
   context  12 482 / 32 768 tok ▓▓▓▓░░░░░░      state: generating
 LAST REQUESTS
   time        P-t/s  G-t/s  p-tok  g-tok  wall    run
   12:04:11    452    21.3   1280   246    12.1s   a1b2c3d4
   ...
 LOG
   12:04:11 slot [0]: print_timing: ... total time = 12104 ms
   ...
 ────────────────────────────────────────────────────────────────────────────────────────
 1 Mon 2 Cfg 3 Chat 4 Bench 5 Hist   m: model  s: stop  ?: help  q: quit
```

**Edge states**: dashboard offline → full-panel error + pm2 hint +
auto-reconnect with backoff (see §7.4); model loading → spinner with
elapsed time (SSE `loadStartTime`); model crashed → red banner with the
fatal line; no model → "nothing loaded" panel with a `2` hint (jump to
Config).

### 6.2 Req 1 — Model selector

- Fuzzy-filterable list from `GET /api/models` — name, size GB, source
  (local `../models` vs HF cache), full path dimmed. The server does the
  scan, so the CLI never touches the filesystem for this.
- Lives in Config mode (sets the profile's model) and as a quick action in
  Monitor (`m` → pick → prompts to relaunch with current profile settings).
- A "paste path" field accepts models outside the scanned dirs (validated
  server-side on launch, same as the dashboard).

### 6.3 Req 2 — Config editor + profiles

A form mirroring the dashboard sidebar, one field per structured key of
`buildLlamaArgs` (server4.js:390) — this is the actual option surface the
full dashboard exposes, so the CLI can't drift from it:

| Group | Fields |
|---|---|
| Core | model (selector §6.2), build (`GET /api/builds` — **fixes ISSUES #1**), ctx, ngl, port |
| Hardware | GPU A / GPU B (`GET /api/devices`, auto-detected on load, manual override — **fixes ISSUES #2**), tensor split, split mode, RPC worker toggle + `host:port` target (`/api/worker/*` endpoints) |
| Cache | flash-attn on/off, `--cache-type-k`, `--cache-type-v` |
| Spec decode | `--spec-type` (draft-mtp / ngram-simple / ngram-map-k / ngram-map-k4v, comma list), draft-n-max/min, draft model path, draft ngl, ngram size-n/size-m/min-hits, `--n-cpu-moe` |
| Sampling | temp, top-k, top-p, min-p, presence penalty, repeat penalty |
| Chat | jinja, chat-template-file, mmproj + path, load mode, verbosity, reasoning-preserve |
| Escape hatch | raw arg string — quote-aware tokenizer (port `tokenizeCommand`, fixes ISSUES #7). Dashboard philosophy preserved: structured fields seed the box, **the box wins** |

- **Live preview**: the exact command that would be sent, computed
  server-side via `POST /api/preview-command` — the same endpoint the
  browser uses, so CLI and web can never disagree about what launches.
- **Flag reference**: `GET /api/flags?build=X` (the parsed `--help`) as a
  searchable overlay (`/`), `Enter` inserts the flag into the raw-args
  field — the dashboard popover, ported.
- **Profiles** (TUI CRUD: save / load / duplicate / rename / delete, list
  view showing model + key knobs per row):
  - storage stays `~/.llama-cli/profiles.json`; new `version: 2` schema:

    ```json
    {
      "version": 2,
      "profiles": {
        "qwen-35b-dual": {
          "modelPath": "/home/kyle/AI/experiment-1/models/...gguf",
          "build": "vulkan-cuda",
          "ctx": 32768, "ngl": 99, "port": 8080,
          "deviceA": "cuda0", "deviceB": "cuda1", "tensorSplit": 55,
          "fa": true, "cacheK": "q8_0", "cacheV": "q8_0",
          "specType": "draft-mtp", "specDraftNMax": 2,
          "temp": 0.2, "topK": 40, "topP": 0.9,
          "nCpuMoe": 10,
          "argString": ""
        }
      }
    }
    ```
  - v1 entries (`{model, args}`) migrate on read (model→`modelPath`,
    args→`argString`); nothing is lost.
  - Field names deliberately match the dashboard's `launchConfig` keys —
    a later nicety is import/export (JSON) so profiles move between the
    browser's localStorage profiles and the CLI's file.
- **Launch / Stop**: `[Launch]` → `POST /api/start` with the structured
  config (server validates: model exists, finite ctx/ngl, valid port and
  build — clean errors land in the TUI, not a stuck state); `[Stop]` →
  `POST /api/stop`. Monitor mode shows the result live.

### 6.4 Req 4 — Chat mode (separate from Monitor, as required)

- Tab 3. Messages → `POST http://localhost:8080/v1/chat/completions` with
  `stream: true`; a ~40-line SSE-chunk parser accumulates deltas.
- UI: scrolling transcript (capped buffer, `Esc`-back to trim), streaming
  tokens, lightweight markdown-ish rendering (bold, headings, code fences
  → ANSI; deliberately *not* a full md renderer — rabbit hole).
- Input: `ink-text-input` at the bottom. `Enter` sends; v1 keeps it
  single-line with a trailing-`\` continuation (raw-mode multi-line input
  is the one place TUI conventions get fiddly across terminals).
- In-chat commands: `/new` (clear conversation), `/model` (what's loaded),
  `/temp 0.4` etc. (client-side sampling overrides for the session),
  `/exit`.
- **Per-request stats**: when the matching `COMPLETION` SSE event arrives
  (client-agnostic capture — it fires for *any* client, including this
  one), the transcript shows a dim footer line for that message: prefill
  t/s, gen t/s, tokens, wall time. Chat and telemetry tie together with
  zero extra plumbing.
- Guard: if server state ≠ `running`, the input is replaced by a "no model
  loaded — press 2" hint. Mode-switching mid-generation does not cancel
  the stream (it keeps accumulating in state; Monitor shows it).

### 6.5 Req 5 — Bench mode: paste or write lines to run as benchmark tests

One mode (tab 4) with two line types (sub-tabs to keep parsing unambiguous):

**(a) Prompt lines — sweeps against the running model.**
Each non-empty line = one benchmark prompt. The CLI POSTs each line
sequentially to :8080 (streaming), and because the server's completion
capture is client-agnostic, every line produces a real CSV row +
`COMPLETION` event carrying prefill/gen t/s, tokens, wall time — plus the
in-flight GPU samples from `/api/logs/active-samples`. A live results
table builds as lines complete; a best/avg summary row at the end.
Results are appended to the server transcript via `POST /api/bench/note`
so they appear in the web Bench tab and in `bench-history.log` — one
history, both clients. This exercises the real server stack (including
speculative decoding, which `llama-bench` can't touch) — that's the point
of this type. Requires the model to be running; if not, the sub-tab is
disabled with a hint.

**(b) llama-bench lines — hardware runs.**
Each line = one `llama-bench` invocation (`-m model.gguf -p 512 -n 128
-r 3`, optional `-dev`/`-ts`/`-fa`). Sent via `POST /api/bench/start`
(`rawArgs` form) → executes in the **server-side** matrix queue: it keeps
running if you quit the TUI (same behavior as the dashboard; the queue
lives in `server4.js`). The TUI shows queue position (n/N + current
label), a live output tail (SSE `BENCH:` lines + `GET /api/bench/status`),
and per-run sample stats; Stop / Dequeue map to `/api/bench/stop`,
`/api/bench/dequeue`.

**Getting lines in** (the "pasting in (or writing)" part):
- a multi-line paste buffer in the mode: terminal **bracketed paste**
  dumps the whole clipboard into the buffer at once (the standard TUI
  answer to "paste a block"); or
- `:file <path>` — read lines from a file (bench suites as text files are
  a natural fit and trivially reusable).
- Blank lines and `#` comments are ignored.

### 6.6 Req 6 — History mode: select past runs, view their data

Data source: `logs/benchmarks.csv` (one row per completed request, written
server-side for *any* client) — plus `bench-history.log` for llama-bench
transcripts.

- **"Run" semantics**: the CSV's `run_id` is per-*request*
  (`generateRunId()` per completed request, server4.js:1009). A
  *launch session* — what "select a historical benchmark run" means — is a
  group of consecutive rows sharing model + launch config. A small new
  backend endpoint makes this deterministic (below); v1 can group
  client-side from `/api/logs/recent?limit=500` if you want to skip it.
- **New endpoint** `GET /api/logs/runs` (~30 lines in `server4.js`):
  distinct groups `{model, configSummary, rowCount, firstTs, lastTs,
  avgGenTps, bestGenTps}` with group boundaries on config change or
  server start/stop. This is the only new API surface the plan requires.
- **UI**: run list (model · date span · n requests · avg/best gen t/s) →
  select → per-request table: time, prompt t/s, gen t/s, prompt/gen
  tokens, wall, load, GPU util/power/temp, net, aborted — sortable
  columns, min/avg/max footer. Row select → detail view: full launch
  command, parsed config JSON, draft-acceptance stats, and the
  per-request GPU sample sparklines via
  `GET /api/logs/samples?runId=<id>` (note: samples only exist for
  requests still in the in-memory ring buffer — older runs show table
  data only; same limitation as the web UI).
- **Filters**: model (distinct values in CSV), transport
  (Local/WiFi/TB4), time range.
- **Export**: `:csv` → `GET /api/logs/csv` → save the full file to disk.

## 7. Backend "packaging" work (small, one-time, all additive)

1. **Optional token auth** (only matters if you use the LAN path, §8).
   `authToken` in `dashboard.config.json` or env `MC_TOKEN`; server checks
   `Authorization: Bearer` (or `?token=`) on all `/api/*` + SSE and
   returns 401; **localhost always passes** so current usage is
   unchanged when the token is unset. CLI reads it from
   `~/.llama-cli/config.json` or `--token`. Important because the server
   already binds `0.0.0.0` (server4.js:2259) — today, anything on the LAN
   can start/stop the model and read logs.
2. **`GET /api/logs/runs`** (§6.6).
3. **SSE heartbeat**: a `: ping` comment line every ~15 s on
   `/api/status` so long-lived connections don't get dropped by proxies
   or idle timeouts; the TUI's reconnect/backoff keys off it.
4. **`API.md`** (at `dashboard/`): endpoints, payload shapes, SSE event
   tags. This is what makes the CLI — and any future client (script,
   phone app, second terminal) — safe to build against. It's the actual
   "package the backend" deliverable.
5. **No restructure of `server4.js`.** 2265 lines in one file is a smell,
   but splitting it now is churn with no feature behind it; leave it.

## 8. Remote use

Your point — a server-backed backend makes the tool usable remotely — is
correct, and the conventions are:

1. **SSH port-forward (recommended, default).**
   `ssh -L 3000:localhost:3000 -L 8080:localhost:8080 kyle@pop-os`
   then run `llama-cli` from your laptop; it talks to
   `http://localhost:3000` and the forwarded :8080 for chat. Zero new
   network exposure, no auth needed, works today. (A TUI over SSH just
   renders in the remote/local tty with a little latency — this is normal
   and fine at 2 Hz.)
2. **Direct LAN.** With §7.1 in place: `llama-cli --server
   http://192.168.1.120:3000 --token ...`. Don't do this before the token
   lands (see §7.1).
3. The only remote-specific CLI surface is `--server` (default
   `http://localhost:3000`) on the global flags. Everything else in the
   TUI is transport-agnostic.
4. Chat needs the model port reachable too: forward :8080 as above (v1:
   documented; the model's actual port is visible in the SSE
   `launchCommand` if a custom port was used).

## 9. Milestones

Phased by priority. **Phase 1 (M0–M2) is the first build target: Monitor +
Launch.** Later phases add modes on the same shell with no rework.

### Phase 1 — Monitor + Launch (first priority)

| # | Scope | Acceptance |
|---|---|---|
| **M0** | Backend basics the TUI depends on: SSE heartbeat, `API.md` contract doc | SSE stream stays alive through idle periods; web UI unchanged; every endpoint the CLI calls is documented in `API.md` |
| **M1** | TUI shell + Monitor mode: ink app, mode router, status bar, `?` overlay, SSE client w/ reconnect, telemetry poller, rolling buffers, full monitor screen + all edge states (offline / loading / running / crashed) | boot a model from the *web* UI and watch it in the TUI at 2 Hz; kill the dashboard process → clean offline screen → auto-reconnect on revival |
| **M2** | Launch flow: minimal-viable config (model selector, build, ctx, ngl, port, GPU A/B + tensor split, raw args), live command preview via `/api/preview-command`, profile save/load (v2 schema + v1 migration), Launch/Stop, auto-jump to Monitor after start | a saved profile boots a 2-GPU split and the launched command equals the web UI's preview output exactly; Stop works from either mode |

### Phase 2 — Full config editor

| # | Scope | Acceptance |
|---|---|---|
| **M3** | Complete the Config surface: all field groups (cache, spec decode, sampling, chat/jinja/mmproj, verbosity, load mode), flag-reference overlay (`/api/flags`), profile duplicate/rename, RPC worker toggle (`/api/worker/*`) | every field round-trips through `/api/start` and matches the web UI's resolved command; flag overlay inserts into raw args |

### Phase 3 — Chat

| # | Scope | Acceptance |
|---|---|---|
| **M4** | Chat mode | streaming chat with per-request stats footer; `/new`; switching to Monitor mid-generation doesn't lose the stream |

### Phase 4 — Bench

| # | Scope | Acceptance |
|---|---|---|
| **M5** | Bench mode (prompt-line sweeps + llama-bench lines) | 5 pasted prompt lines → 5 CSV rows + a note visible in the web Bench tab; 3 llama-bench lines → queue completes with the TUI closed (reopen to see results) |

### Phase 5 — History + remote hardening

| # | Scope | Acceptance |
|---|---|---|
| **M6** | History mode + `GET /api/logs/runs` + optional token auth (only if LAN remote use is wanted, §7.1/§8) | pick a past run → per-request table + sparklines (where samples exist) → export CSV file; auth: curl with/without token behaves per spec, localhost always passes |

### Phase 6 — Polish

| # | Scope | Acceptance |
|---|---|---|
| **M7** | Keymap consistency, `NO_COLOR`, 80×24 layout, README (usage, keymap, remote setup), smoke-test script (start dashboard → boot small model → run one prompt → quit, all scripted) | smoke script passes unattended |

Rough feel for a web-dev brain writing ink: M0 ≈ 0.5 d; M1 ≈ 2–3 d (the
learning curve lives here); M2 ≈ 2–3 d; M3 ≈ 2 d; M4 ≈ 1–2 d; M5 ≈ 2 d;
M6 ≈ 2–3 d; M7 ≈ 1 d. After M1 everything is wiring + tables.

## 10. Risks / open questions

- **ink performance at 2 Hz with tables**: fine in practice (btop itself
  runs ~1–2 Hz), but memoize section components; if it ever stutters, drop
  the default cadence to 1 Hz via `~/.llama-cli/config.json`.
- **Terminal variance**: raw-mode keymaps (Shift-Enter, bracketed paste)
  differ across terminals. Keep the v1 keymap minimal (arrows, Enter,
  Esc, q, ?, 1–5, /) and test in the terminal you actually use daily.
- **Dashboard orphan-cleanup interaction**: restarting the dashboard
  `fuser -k`s :8080/:8081 and kills a deliberately-running model (existing
  behavior, documented in the dashboard README). The TUI should surface
  the "model died: dashboard restarted" case distinctly from a crash.
- **Run grouping heuristic**: model+config+time-gap grouping can
  mis-group back-to-back launches of identical configs — hence the
  server-side `/api/logs/runs` with explicit boundaries on config change /
  server start-stop (deterministic, not heuristic).
- **Chat markdown**: keep it dumb (bold/fences/headings). A real md
  renderer in a TUI is a rabbit hole.
- **Open: RPC worker management in the TUI?** The `/api/worker/*`
  endpoints exist (start/stop over SSH like the web Worker box). A toggle
  in Config mode is ~half a day; included in M2 if you use RPC regularly,
  otherwise defer.
- **Open: non-TUI subcommands.** Keep a thin set for scripting
  (`llama-cli models`, `profile list/save/delete`, `history export
  [--model X]`); everything else is TUI. Deliberately no headless bench
  runner in v1 — `curl`/`llama-bench` already are headless bench runners.

## 11. New file layout

```
llama-cli/
  cli.js               # shebang + commander: global flags (--server, --token),
                       #   TUI-first entry (`llama-cli` opens the app), thin
                       #   non-TUI subcommands (models, profile, history export)
  src/
    app.js             # <App/>: mode router, status bar, help overlay,
                       #   global error/offline screens
    client.js          # fetch wrapper + SSE client (heartbeat timeout,
                       #   reconnect w/ backoff) + typed event names
    state.js           # app store (React context + useSyncExternalStore)
    config.js          # ~/.llama-cli/config.json (server URL, token, cadence)
    profiles.js        # v2 profile CRUD + v1 migration (rewritten from lib/)
    modes/
      monitor.js       # req 3
      config.js        # reqs 1–2
      chat.js          # req 4
      bench.js         # req 5
      history.js       # req 6
    components/        # sparkline, bar, table, fuzzy-list, keymap-bar
  package.json         # ink, react, ink-text-input, ink-select-input,
                       #   ink-table, ink-spinner, commander
  README.md            # usage, keymap, remote setup (replaces current)
  ISSUES.md            # retired with the old code (all items resolved by
                       #   the rewrite or by not carrying the code forward)
```

Retired: `cli.js` (old), `lib/tui.js`, `lib/menu.js`, `lib/parser.js`,
`lib/telemetry.js` (~620 lines). Kept: the `llama-cli` bin name and the
`~/.llama-cli/` config home.
