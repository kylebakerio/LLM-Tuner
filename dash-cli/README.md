# Llama CLI — btop-style TUI for Mission Control

A terminal UI for the llama.cpp dashboard (`../server4.js`, port 3000). The
dashboard is the control plane (it spawns `llama-server`, parses its logs,
writes the benchmark CSV, runs `monitor.py`); this tool is a client of it —
the same relationship the browser UI has. Nothing here spawns processes or
keeps its own state: one source of truth, two front ends.

Phase 1 is built: **Monitor** (live btop-style telemetry), **Launch**
(config editor, profiles, start/stop), and **Chat** (streaming conversation
with image attach, thinking control, and an optional web-search tool).
Bench and History ship in later phases (see `PLAN.md`) — keys 4/5 show
placeholders.

## Requirements

- Node.js >= 18 (this machine has 20)
- The dashboard running: `pm2 status` in `../` (or `node server4.js`)

## Install

```bash
cd llama-cli
npm install
```

## Usage

```bash
node cli.js            # open the TUI (or: npm start)
node cli.js models     # list models (via dashboard API), non-interactive
node cli.js profile list           # most recently used first, type RPC/Local
node cli.js profile save <name> -m <model.gguf> [-a "--ctx 8192 --ngl 99"]
node cli.js profile delete <name>
node cli.js tunnel status          # is the remote tunnel up? what's the URL?
node cli.js tunnel stop            # tear it down (also drops the password gate)
```

All subcommands accept `--server <url>` (or `-s`) and `--token <password>`
(or `MC_TOKEN` env var) for reaching a gated dashboard through a tunnel
(see **Remote use** below).

### TUI

| Key | Action |
|---|---|
| `1` / `2` / `3` | Monitor / Launch / Chat mode (`4`/`5`: Bench/History, not built yet). In Chat a bare digit is text, so use `alt+1..5`, the `/1`../`5` commands, or click the tab |
| `?` | keymap for the current mode |
| `q` or `Ctrl-C` | quit the TUI (the model server keeps running) |

**Monitor (1)** — btop-style boxed panels: GPU 0/1 side by side (util,
VRAM incl. model-vs-other split, power, temp, throttle badges, braille
sparklines, color-graded bars), prefill/gen t/s with live progress,
context usage, last 3 completed requests with per-request t/s ranges
(`245(230–260)`, from the server-computed min/max; backfilled from the
benchmark CSV, then live via `COMPLETION` events), CPU/RAM/network, and a
tail of the `llama-server` log.

During an RPC run (`isRpc` in the SSE state) the GPU panels are titled
**Local** (this host's card — currently the AMD 7900 XTX) and **Worker
(rpc)** (the laptop's RTX 4090). The worker panel stays up if its
telemetry drops and shows as offline. The SYSTEM panel has a permanent `wrk` row
with the worker's CPU util/temp and RAM. Panels are vendor-neutral: a GPU
counts as offline when `gpu_name` is `Offline` or either
`nvidia_smi_error` or `amdgpu_top_error` is set.

| Key | Action |
|---|---|
| `x` | stop the model server (asks y/N) |
| `s` | jump to Launch |

**Launch (2)** — the full launch config as a grouped form covering the
entire `buildLlamaArgs` surface: **core** (model from `/api/models`,
build from `/api/builds`, ctx, ngl, port), **hw** (GPU A/B from
`/api/devices`, tensor split 0-99, RPC worker on/off, worker host,
transport), **cache** (flash-attn,
KV cache K/V quants), **spec** (spec type incl. comma lists, draft
n-max/n-min/model/nGl, ngram size-n/size-m/min-hits, n-cpu-moe),
**sample** (temp, top-k, top-p, min-p, presence/repeat penalty), **chat**
(jinja, reasoning-preserve, chat-template-file, mmproj + path + GPU-offload
toggle, load mode, verbosity — minimum 3, same as the web: lower levels
make `llama-server` drop the log lines the dashboard parses; older
profiles below 3 are clamped up on load), **raw** (escape-hatch arg string). The **command preview is
resolved server-side** (`POST /api/preview-command`, the same endpoint the
web UI uses), so the CLI and the browser can never disagree about what
will actually launch. If a model is already running, the form prefills
from its live `launchConfig` — **every** field, so KV quants, the spec
stack, sampling and jinja all carry over (a 262k f16-KV launch prefills
as the q8_0-KV launch it really was).

| Key | Action |
|---|---|
| `↑/↓` (or `j/k`) | move between fields |
| `Tab` / `←` | next / previous field group |
| `Enter` / `→` | edit the focused field (lists fuzzy-filterable; toggles flip in place) |
| `p` | save profile (prompts for a name) |
| `l` | load profile (most recently used first, each tagged `RPC` or `Local`) |
| `d` | delete the loaded profile (y/N) |
| `r` | rename the loaded profile (prompts for a name) |
| `c` | duplicate the loaded profile (copies the saved config, not a dirty draft) |
| `/` | flag reference for the selected build (fuzzy-filterable; `Enter` inserts the flag into raw args) |
| `w` | start/stop the RPC worker on the **Worker host** over SSH (RPC must be on; y/N confirm; same `/api/worker/*` endpoints as the web Worker box; a failed start shows the server's error incl. the worker's startup log tail) |
| `L` | worker logs overlay — last 50 lines from `POST /api/worker/logs`, refreshed every 3 s while open (`Esc` closes) |
| `b` | launch → auto-switches to Monitor |
| `x` | stop the model server |

**RPC (split with the worker laptop)** — in the **hw** group:

- **RPC worker** (toggle) is the on/off switch. **Worker host** is the
  SSH target: a `~/.ssh/config` alias (`laptop`) or `user@host`. It is filled from
  `GET /api/worker/config` (`ssh`) when empty. At launch/save/preview the
  two fields become the dashboard's single `rpcTarget` (the host when on,
  `''` when off). Loading a profile or prefilling from a running config
  does the reverse: a non-empty `rpcTarget` means RPC is on, with that host.
- While RPC is on, **GPU B** is locked to None, because the split is exactly
  local GPU A vs the worker (the server emits `-dev <A>,RPC0 -ts N,M`).
  GPU A is relabeled **Local** and the tensor split shows `Local N% / Worker M%`.
  **Transport** (`WiFi` / `TB4` / `WAN`) appears and is sent only while
  RPC is on; it's `null` otherwise. It's used for CSV/history grouping.
- The RPC row shows a worker status badge (`RUNNING` / `STOPPED` /
  `OFFLINE` / `ERROR`), polled every 5 s via `POST /api/worker/status`.
  Polling runs only while RPC is on and Launch mode is open.
- **You don't need to start the worker before launching.** With RPC on,
  `b` calls `/api/start`, which auto-starts the worker over SSH if it isn't
  running. It then waits up to ~25 s for the RPC port before spawning
  `llama-server`. Launch shows `launching (starting RPC worker on <host> if
  needed)…` meanwhile. If the worker can't be started or reached, the
  server's error text is shown.
- Profiles round-trip with the web (both store `rpcTarget` + `transport`).
  The web's `rawCommand` (its raw command box) is **dropped** on load and
  never sent or saved by the CLI. `/api/start` runs a non-empty
  `rawCommand` verbatim and ignores every structured field, so a stale one
  would silently override your edits. Unknown keys are dropped too.

- **Mouse** — group tabs, field rows, and toggle fields are clickable
  (the mode tabs up top are clickable in every mode). Left-clicks are
  matched under both SGR button conventions (0 = left, and the X11-style
  1 = left that some terminals report), so clicks work in either. While
  a text-field editor is open, terminal mouse tracking is suspended so
  the terminal's own middle-click primary-selection paste works there
  too (instead of the click being reported into the field as text).

Profiles are **shared with the web dashboard** and stored server-side
(`GET/POST/DELETE /api/profiles`, file `logs/profiles.json` on the
dashboard host) — a profile saved in either front end shows up in both,
and both stamp a "last used" time when a profile is applied. The CLI's
former `~/.llama-cli/profiles.json` was imported by the server at first
boot (v1 `{model, args}` entries included); the browser's former
localStorage profiles import automatically on its next page load. Field
names match the dashboard's `launchConfig` keys.

**Chat (3)** — a streaming conversation with the running model, same
parity as the web UI's chat. Messages are sent through the dashboard's
`POST /api/chat` (a streaming pass-through to `llama-server`), so requests
are recorded to the benchmark CSV exactly like any other client's, and the
mode works unchanged when the dashboard is reached through a tunnel.

- **Thinking control** — `^t` cycles the chat template's thinking level
  (`xhigh → medium → low → off → xhigh …`), sent per request as
  `chat_template_kwargs: { enable_thinking, reasoning_effort }`. `^o`
  cycles how the model's reasoning is *displayed*: last 8 lines → full
  (every line, for reviewing the chain) → hidden (the model still thinks
  either way). `^w` toggles the **web search tool**:
  when on, the model may answer with a `web_search` tool call, which the
  CLI executes server-side (`POST /api/web-search`, keyless DuckDuckGo) and
  feeds back; the loop runs up to 4 rounds and the tool exchange is kept in
  context so citations stay grounded.
- **Media attach** — type (or paste) a media file path in the input and it
  becomes a `[image n]` / `[video n]` / `[audio n]` placeholder in the text
  plus a content part in the request: images as `image_url` (base64 data
  URI, up to 8 / 25 MB each), video/audio as raw base64 `input_video` /
  `input_audio` parts the server samples/decodes (up to 2 files / 25 MB
  each -- needs a loaded mmproj with that support).
- **Middle-click paste** — on Linux/X11 terminals the mouse middle-click
  (button 2) inserts the primary selection into the input at the cursor.
- **Markdown-ish replies** — model text gets light styling: bold,
  headings, fenced code, inline code, and links (deliberately not a full
  md renderer; the live streaming preview stays plain).
- **Live + final stats** — while a reply generates, a line shows elapsed
  time, gen t/s (avg + instantaneous), and context used, reading the same
  `GEN_PROGRESS` / `CTX_LIVE` stream Monitor's panel does. After the reply,
  the final `COMPLETION` event's t/s + token counts are shown under the
  message.
- **Survives tab switches** — Chat stays mounted while you look at
  Monitor/Launch, so an in-flight reply (and its thinking stream) keeps
  running and is right there when you switch back.

| Key | Action |
|---|---|
| `Enter` | send (multi-line via backslash at line end) |
| `Esc` | cancel the in-flight request |
| `^t` | cycle thinking level (xhigh/medium/low/off) |
| `^o` | cycle thinking display: last 8 lines → full → hidden (display only) |
| `^w` | allow web search (tool call) on/off |
| `/new` | clear the conversation |
| `/model` | show the running model |
| `/temp` | show sampling params from the live launch config |
| `/think` · `/web` · `/show` · `/hide` | set thinking level · web search on/off · thinking display (`thinking`/`full`) · hide thinking |
| `/m` · `/l` · `/1`../`/5` · `/exit` | jump to Monitor / Launch / that tab / quit the TUI |
| `/help` | the mode's keymap · `/exit` also exits the TUI from here |

## Configuration

`~/.llama-cli/config.json` (created on demand; all optional):

```json
{ "server": "http://localhost:3000", "telemetryMs": 1000, "token": "s3cret" }
```

Precedence: `--server <url>` (TUI flag, or `-s` on the subcommands) >
`MC_SERVER` env var > `server` in this file. Same for the tunnel password:
`--token <pw>` > `MC_TOKEN` > `token` in this file.

## Remote use

Three ways, from most to least preferred:

**1. SSH port forward (no exposure, no auth):**

```bash
ssh -L 3000:localhost:3000 kyle@host
llama-cli    # talks to the forwarded port
```

**2. Cloudflare tunnel + password gate (the dashboard's "Remote access"
toggle, or `POST /api/tunnel` from any client).** This is the way to reach
the dashboard from anywhere — including a *browser* (the tunnel URL opens
the live web dash behind a login page) and a *CLI* from another machine:

```bash
# on the dashboard host: start the tunnel (from the web sidebar, or)
curl -s -X POST localhost:3000/api/tunnel \
     -d '{"action":"start","password":"s3cret"}'
# -> {"active":true,"url":"https://xxx.trycloudflare.com"}

# from any machine (the CLI probes /api/tunnel, sees the gate, and
# prompts for the password — or take it from --token / MC_TOKEN):
llama-cli -s https://xxx.trycloudflare.com
llama-cli models -s https://xxx.trycloudflare.com --token s3cret
```

While the tunnel is up the gate is **global**: every request to the
dashboard (local or remote) needs `Authorization: Bearer <password>` or a
browser session cookie from the login page. Stop it with
`llama-cli tunnel stop -s https://xxx.trycloudflare.com --token s3cret`
(or the sidebar) and local access returns to its normal unauthenticated
state. The password is held only in server memory (PBKDF2 + per-boot salt)
— restarting the dashboard revokes the tunnel, the gate, and all sessions.
`cloudflared` must be on the dashboard host's PATH.

**3. Direct LAN access** (`MC_SERVER=http://192.168.x.x:3000`) works
whenever no tunnel is active — the dashboard binds all interfaces and has
no auth in that mode. Prefer the tunnel when the LAN is untrusted.

## Testing

```bash
npm test                       # unit tests (node:test, no deps):
                                 # SSE client + reconnect, REST, profiles
                                 # (server-API contract), launch-config
                                 # mapping (RPC draft<->rpcTarget, rawCommand
                                 # sanitizing, verbosity floor), store, ink
                                 # renders, chat helpers (thinking kwargs,
                                 # image attach, tool replay)
bash test/live-cycle.sh        # full end-to-end launch cycle (stops the
                                 # current model for ~1-2 min, restores it)
```

## Architecture

```
cli.js                 entry: TUI bootstrap + non-interactive subcommands
src/client.js          HTTP + SSE client (reconnect w/ backoff, idle watchdog
                       keyed off the server's 15s `: ping` heartbeats)
src/state.js           external store: SSE events + telemetry poller ->
                       rolling buffers, live progress, completions, log tail
src/profiles.js        shared profiles via /api/profiles (server-side)
src/launchconfig.js    pure draft <-> launch-config mapping (RPC switch/host
                       <-> rpcTarget, profile sanitizing, sort/tag helpers)
src/config.js          ~/.llama-cli/config.json
src/app.js             mode router, global keys, input gating, help overlay
src/modes/monitor.js   Mode 1
src/modes/launch.js    Mode 2
src/modes/chat.js      Mode 3 (streaming chat: image attach, thinking
                       levels, web-search tool loop, middle-click paste)
src/components/        sparklines, bars, fuzzy list, status bar, help
```

No JSX, no build step — `React.createElement` via the `h` alias in
`src/h.js`, plain `node cli.js`.

The old proof-of-concept (raw ANSI renderer, its own `llama-server`
spawner, 5s poller) is preserved in `legacy/` and is superseded.

## Notes / known limits

- Uptime in the header only counts when the TUI observed the
  start→ready transition (the SSE stream carries no start timestamp for a
  model that was already running).
- Per-request GPU sample sparklines (the "omni" graph) need
  `/api/logs/samples` — wired in with History (Phase 5).
- Chat mode hits the dashboard's `POST /api/chat` (a streaming pass-through
  to `llama-server`), not the model port directly — so it works through a
  tunnel and the server's client-agnostic capture still records every
  request to the benchmark CSV regardless of which client sent it.
