# Llama CLI — btop-style TUI for Mission Control

A terminal UI for the llama.cpp dashboard (`../server4.js`, port 3000). The
dashboard is the control plane (it spawns `llama-server`, parses its logs,
writes the benchmark CSV, runs `monitor.py`); this tool is a client of it —
the same relationship the browser UI has. Nothing here spawns processes or
keeps its own state: one source of truth, two front ends.

Phase 1 is built: **Monitor** (live btop-style telemetry) and **Launch**
(config editor, profiles, start/stop). Chat, Bench, and History ship in
later phases (see `PLAN.md`) — keys 3/4/5 show placeholders.

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
node cli.js profile list
node cli.js profile save <name> -m <model.gguf> [-a "--ctx 8192 --ngl 99"]
node cli.js profile delete <name>
```

### TUI

| Key | Action |
|---|---|
| `1` / `2` | Monitor / Launch mode (`3`–`5`: Chat/Bench/History, not built yet) |
| `?` | keymap for the current mode |
| `q` or `Ctrl-C` | quit the TUI (the model server keeps running) |

**Monitor (1)** — btop-style boxed panels: GPU 0/1 side by side (util,
VRAM incl. model-vs-other split, power, temp, throttle badges, braille
sparklines, color-graded bars), prefill/gen t/s with live progress,
context usage, last 3 completed requests with per-request t/s ranges
(`245(230–260)`, from the server-computed min/max; backfilled from the
benchmark CSV, then live via `COMPLETION` events), CPU/RAM/network, and a
tail of the `llama-server` log.

| Key | Action |
|---|---|
| `x` | stop the model server (asks y/N) |
| `s` | jump to Launch |

**Launch (2)** — the full launch config as a grouped form covering the
entire `buildLlamaArgs` surface: **core** (model from `/api/models`,
build from `/api/builds`, ctx, ngl, port), **hw** (GPU A/B from
`/api/devices`, tensor split 0-99, RPC target), **cache** (flash-attn,
KV cache K/V quants), **spec** (spec type incl. comma lists, draft
n-max/n-min/model/nGl, ngram size-n/size-m/min-hits, n-cpu-moe),
**sample** (temp, top-k, top-p, min-p, presence/repeat penalty), **chat**
(jinja, reasoning-preserve, chat-template-file, mmproj, load mode,
verbosity), **raw** (escape-hatch arg string). The **command preview is
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
| `l` | load profile |
| `d` | delete the loaded profile (y/N) |
| `b` | launch → auto-switches to Monitor |
| `x` | stop the model server |

Profiles are **shared with the web dashboard** and stored server-side
(`GET/POST/DELETE /api/profiles`, file `logs/profiles.json` on the
dashboard host) — a profile saved in either front end shows up in both,
and both stamp a "last used" time when a profile is applied. The CLI's
former `~/.llama-cli/profiles.json` was imported by the server at first
boot (v1 `{model, args}` entries included); the browser's former
localStorage profiles import automatically on its next page load. Field
names match the dashboard's `launchConfig` keys.

## Configuration

`~/.llama-cli/config.json` (created on demand; all optional):

```json
{ "server": "http://localhost:3000", "telemetryMs": 1000 }
```

Precedence: `--server <url>` (TUI flag, or `-s` on the subcommands) >
`MC_SERVER` env var > `server` in this file.

## Remote use

The TUI is a client, so it works over SSH. Preferred (no exposure, no
auth needed):

```bash
ssh -L 3000:localhost:3000 -L 8080:localhost:8080 kyle@host
llama-cli    # now talks to the forwarded ports
```

Direct LAN access works too (`MC_SERVER=http://192.168.x.x:3000`) — the
dashboard already binds all interfaces but has **no auth**; a token scheme
is planned in Phase 5 (`PLAN.md` §7.1). Don't rely on LAN mode until it
lands.

## Testing

```bash
npm test                       # 18 unit tests (node:test, no deps):
                                # SSE client + reconnect, REST, profiles
                                # (server-API contract), store, ink renders
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
src/config.js          ~/.llama-cli/config.json
src/app.js             mode router, global keys, input gating, help overlay
src/modes/monitor.js   Mode 1
src/modes/launch.js    Mode 2
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
- Chat mode will hit `llama-server:8080` directly, same as the dashboard's
  Interactive tab; the server's client-agnostic capture records those
  requests to CSV regardless of which client sent them.
