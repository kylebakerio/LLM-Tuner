# Llama CLI — btop-style TUI for LL-Dash

A terminal UI for the llama.cpp dashboard (`../server4.js`, port 3000). The
dashboard is the control plane (it spawns `llama-server`, parses its logs,
writes the benchmark CSV, runs `monitor.py`); this tool is a client of it —
the same relationship the browser UI has. Nothing here spawns processes or
keeps its own state: one source of truth, two front ends.

Three modes: **Monitor** (live btop-style telemetry), **Launch** (pick a
saved profile, review the resolved command, launch; stop/restart; a config
editor behind `e`), and **Chat** (streaming conversation with image attach,
thinking control, and an optional web-search tool). Benchmarks and history
live in the web dashboard; the Bench/History tabs planned in `PLAN.md` were
never built and their placeholder tabs are gone.

## Requirements

- Node.js >= 18 (this machine has 20)
- The dashboard running: `pm2 status` in `../` (or `node server4.js`)

## Install

```bash
cd dash-cli            # this directory (the command is still `llama-cli`)
npm install
```

## Usage

```bash
node cli.js            # open the TUI (or: npm start)
node cli.js models     # list models (via dashboard API), non-interactive
node cli.js profile list           # runnable on this machine first; placement, type RPC/Local
node cli.js profile save <name> -m <model.gguf> [-a "--ctx 8192 --ngl 99"]
node cli.js profile delete <name>
node cli.js tunnel status          # is the remote tunnel up? what's the URL?
node cli.js tunnel stop            # tear it down (also drops the password gate)
node cli.js livechat               # stream the running benchmark's agent/model
                                   # conversation (codebench record-proxy tap)
```

All subcommands accept `--server <url>` (or `-s`) and `--token <password>`
(or `MC_TOKEN` env var) for reaching a gated dashboard through a tunnel
(see **Remote use** below).

### TUI

| Key | Action |
|---|---|
| `1` / `2` / `3` | Monitor / Launch / Chat mode. In Chat a bare digit is text, so use `alt+1..3`, the `/1`../`3` commands, or click the tab |
| `?` | keymap for the current screen (it replaces the mode view while open; `Esc` or `?` closes it) |
| `q` or `Ctrl-C` | quit the TUI (the model server keeps running) |

**Monitor (1)** — btop-style boxed panels: one per GPU, side by side (util,
VRAM incl. model-vs-other split, power, a temp line — the card's temperature
and, where the card has the sensors, memory temperature and fan speed (rpm,
else percent; a missing sensor is left out) — throttle badges, braille
sparklines, color-graded bars), prefill/gen t/s with live progress,
context usage, last 3 completed requests with per-request t/s ranges
(`245(230–260)`, from the server-computed min/max; backfilled from the
benchmark CSV, then live via `COMPLETION` events), CPU/RAM/network, and a
tail of the `llama-server` log.

There is **one GPU panel per physical card** of the machine, whatever the
machine is: the cards come from the server's topology (`GET /api/topology`),
so nothing in the CLI names a card. Each panel is titled with the card's
topology label — two identical cards are `RX 7900 XTX #1` and
`RX 7900 XTX #2` — followed, during a launch, by the device id and share the
launch uses on it (`ROCm1 50%`, or `not in launch`), otherwise by the
reading's PCI address. An RPC worker's card gets its own panel
(`RTX 4090 Laptop@laptop · RPC0 40%`). A machine with no GPU shows a single
`NO GPU` panel. Readings always come from the card's own entry in the
telemetry `gpus` list (matched by card name, identical cards in list order),
never from the per-launch-device record. The state line ends with the
machine in one phrase (`2x RX 7900 XTX 24G | 63G RAM`), and the line under it
lists the benchmark-queue lanes that are running
(`queue: laptop-4090 (4090 llama) gen 19 t/s · 6/22`) — a lane on another
machine has no panel, since the server sends no readings for its cards.

Against a server that sends no topology the panels follow the telemetry as
before: one per launch device (`Vulkan1 · RX 7900 XTX`), else one per GPU
(`GPU 0`, `GPU 1`, …), else the old **Local** / **Worker (rpc)** pair. Two
panels fit per row, three once the terminal is ≥ 122 columns wide, and extra
panels wrap onto more rows. A card whose telemetry drops keeps its panel,
shown as offline, so the screen height only changes when the machine or the
device list does. Sparkline histories are kept per card. A panel title or a
placement cell too long for its width is cut in the name, never in the
`#1` / `#2` that tells identical cards apart.

The SYSTEM panel has the local CPU and RAM, one row per RPC worker host
(its CPU util/temp and RAM, or `telemetry offline`), and net throughput
summed over every host. Panels are vendor-neutral: a GPU counts as offline
when it has no reading, `gpu_name` is `Offline`, or `error`,
`nvidia_smi_error` or `amdgpu_top_error` is set.

| Key | Action |
|---|---|
| `x` | stop the model server (asks y/N) |
| `s` | jump to Launch |

**Launch (2)** — profile-first. The top line always says what the
dashboard's server is running — model, context, cards, uptime (or
`no model running`, or the loading state) — and, while something runs, the
line under it spells out `x stop` / `R restart`. Key hints for the current screen are always on
the bottom lines. Three screens:

**1. Profiles** (what you see first) — the saved profiles, one line each:
the ones this machine can run first (most recently used first), then, dimmed,
the ones it can't:

```
LAUNCH  ○ no model running

 Profiles · 4 of 5 run here (u hides the rest) · 2x RX 7900 XTX 24G | 63G RAM · most recently used …
 filter: (none — press / and type)
    PROFILE               MODEL              CTX PLACEMENT            BUILD LAST USED
›   both cards · layer    alpha-27b-Q4_K_XL 131k 2x RX 7900 XTX, 1:1  all   1h ago
    both cards · tensor   alpha-27b-Q4_K_XL 131k 2x RX 7900 XTX, 1:1  all   2h ago
    second card only      alpha-27b-Q4_K_XL 131k RX 7900 XTX #2 alone all   3h ago
  ~ stand-in · small card alpha-27b-Q4_K_XL 131k RX 7900 XTX #1 alone all   4h ago
  – old · one NVIDIA card alpha-27b-Q4_K_XL 131k Needs RTX 3060.      all   unavailable
```

- Which profiles can run here is the server's call: `GET /api/profiles`
  sends `availability` (`{ status, reason, placement }` per profile) and the
  machine's `topology`. `ready` profiles are listed plainly; `~` marks one
  that runs with a note (`moved`: its device ids changed; `substitute`: a
  stand-in card, not validated here — the note is on the detail line); `–`
  and `unavailable` mark one this machine can't run, with the server's reason
  in the PLACEMENT cell. `u` hides / shows those. The title line has the
  counts and the machine. A server that sends no `availability` gets every
  profile listed as ready, in plain most-recently-used order.
- PLACEMENT is the server's text for where the launch sits (`RX 7900 XTX #2
  alone`, `2x RX 7900 XTX, 1:1`). Without it, the same wording is derived
  from the profile's own device names.
- `✗ … MISSING` (red): the profile's model file is not in the dashboard's
  model scan (`GET /api/models`, matched by path, resolved path or alias) —
  it was deleted or moved. A Strata profile is checked against
  `GET /api/strata/configs`, which lists the base configs of every Strata
  install the dashboard is configured with (each with its install and
  version; the detail line and the review say `Strata engine 0.1.43.1`).
  An older dashboard lists one directory only: a base config outside it is
  then not marked. No marker is shown while the catalog hasn't loaded.
- `never used`: no launch or load has been recorded for it (`lastLoadedAt`
  unset), from the web or the CLI.
- Under the list, the selected profile in full: name, model path, last used,
  its `tuningNote`.
- Context is in thousands of tokens, floored (`131k` = 131,072).
- **Strata-engine** profiles (`engine: strata`) launch from here like any
  other (the dashboard resolves the base config file); `e` opens them in the
  **Strata editor** (below), not the llama-server one.

| Key | Action |
|---|---|
| `↑/↓` (or `j/k`), `PgUp`/`PgDn`, click | select a profile |
| `Enter` / `→` | review it (screen 2) — nothing starts yet |
| `/` | filter: type, `Enter` reviews the selected match, `Esc` clears. Words match as written (`terse 128`); if nothing matches that way it falls back to a fuzzy match |
| `e` | edit the selected profile in the config editor (screen 3) |
| `n` | open the config editor without loading a profile (a new config, or the running one) |
| `N` | open the Strata editor without loading a profile (a new Strata-engine config) |
| `u` | hide / show the profiles this machine can't run |
| `d` / `r` / `c` | delete (y/N) / rename / duplicate the selected profile. Rename and duplicate copy the saved config as it is (Strata keys and `tuningNote` included; only `rawCommand` is dropped) and never overwrite another profile |
| `x` | stop the model server (y/N) |
| `R` | restart it with the same config (y/N) |

**2. Review** — `Enter` on a profile (or `b` in the editor) shows exactly
what would launch, resolved by the dashboard (`POST /api/preview-command`,
which never spawns anything): model and file, context, build, **the cards
it will use** (the server's device plan — ids re-pointed, RPC ids
assigned; each named by its topology label, so two identical cards read
`#1` and `#2`), **the split mode** when it uses more than one, the note, the
full command, and the server's warnings.

```
 Launch profile “both cards · tensor”

   model    alpha-27b-Q4_K_XL
            /models/alpha-27b-Q4_K_XL.gguf
   context  131,072 tokens   build all — ROCm + Vulkan
   cards    RX 7900 XTX #1 (ROCm0) 50%  ·  RX 7900 XTX #2 (ROCm1) 50%
   split    tensor (-sm tensor) — experimental
   command  /x/build-all/bin/llama-server -m /models/alpha-27b-Q4_K_XL.gguf -c 131072 -ngl 999
            --host 127.0.0.1 --port 8080 -fa on --split-mode layer -dev ROCm0,ROCm1 -ts 50,50 -sm
            tensor -lv 3

╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ⚠ CARD BUSY — a benchmark is running on a card this launch needs                                 │
│   RX 7900 XTX #2 (ROCm1) — queue item 901 “bench-alpha-128k” · lane local-2                      │
│ Launching takes the card from that run — it needs a second confirmation.                         │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯

Enter: launch (asks once more)  e: edit before launching  Esc: back to profiles
```

**Split mode.** A launch on two or more devices is split by `layer` (the
dashboard's default: whole layers per device, in `-dev` order) or by
`tensor` (experimental; the config's `splitMode` field, or `-sm tensor` in
its raw args, which wins). The mode shown is the preview's own `splitMode`
when the server sends one, else read from the resolved command. In the list,
a multi-card profile that is not split by layer says so in its PLACEMENT cell
(`2x RX 7900 XTX, 1:1 · tensor`). llama.cpp's `row` mode is
deprecated and fails to load: a saved `-sm row` is shown in red and asks a
second time, and it is never offered as a choice.

A profile the server marks `unavailable` gets a box of its own, and `Enter`
does not launch it:

```
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ⚠ NOT RUNNABLE HERE — this profile needs hardware this machine does not have                     │
│   Needs RTX 3060.                                                                                │
│   this machine: 2x RX 7900 XTX 24G | 63G RAM                                                     │
│ Enter does not launch it. e edits it for this machine; O overrides and launches it as saved.     │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯

O: override (asks once more)  e: edit for this machine  Esc: back to profiles
```

(The boxes only appear when they apply. The panel fits itself to the
terminal height: the note, then the command, are shortened with `…` on a
short terminal — the warnings never are.)


| Key | Action |
|---|---|
| `Enter` | launch → auto-switches to Monitor. If something is at stake (below) it asks once more instead |
| `y` | at that second question (`Launch anyway? This will: … [y/N]`): go ahead. Only `y` does — `Enter` and other keys don't |
| `O` | only on a profile this machine can't run: override — opens the second question; `y` there launches the config exactly as saved (no id is re-pointed by the CLI) with `allowUnavailable: true` on that one request, which is what the dashboard needs to start such a launch. No `force` is sent: that flag is the busy-card override only |
| `e` | edit before launching (opens the editor on this profile) |
| `Esc` | back |

What sends `Enter` to the second question:

- **Busy cards.** The preview's `busy` list (benchmark-queue items running
  on a card this launch needs) is shown in the red box. After `y` the launch
  is sent with `force: true` — the flag goes on that one request, never into
  the profile or the draft. If `/api/start` answers **409 `CARD_BUSY`**
  without a prior warning (the queue moved since the preview), the same
  question opens with the 409's list, and `y` resends with `force: true`.
  A dashboard without the guard sends no `busy` field: no warning, plain
  launch.
- **Not runnable here.** If `/api/start` answers **409 `UNAVAILABLE_HERE`**
  for a launch the review had not flagged (a draft, a restart, a dashboard
  that sent no availability), the review reopens on the second question with
  the server's reason; `y` resends with `allowUnavailable: true`, `n` goes
  back to the review, where `Enter` is now blocked like any profile this
  machine can't run. Like `force`, the flag is never written into the
  profile or the draft.
- **A stand-in card** (`substitute`), or a deprecated split mode (`-sm row`).
- **A server is running.** The CLI stops it (`POST /api/stop`), waits for
  the old process to exit (`/api/start` answers `Running` for a few
  seconds; retried for up to 20 s), then starts the new one.
- **The model file is missing**, or an external llama-server already holds
  the launch port.

Restart (`R`) is the same stop-then-start with the launch config the
dashboard reported for the running server, resent unchanged (there is no
restart route).

**3. Config editor** (`e` / `n`; also where Launch opens when no profile has
been saved yet) — the full launch config as a grouped form covering the
entire `buildLlamaArgs` surface: **core** (model from `/api/models`,
build from `/api/builds`, ctx, ngl, port), **hw** (the device list, see
below: one row per card and RPC worker, Suggest split, transport), **cache** (flash-attn,
KV cache K/V quants), **spec** (spec type incl. comma lists such as `draft-mtp,ngram-mod`, draft
n-max/n-min/model/nGl/device, ngram size-n/size-m/min-hits, n-cpu-moe),
**sample** (temp, top-k, top-p, min-p, presence/repeat penalty), **chat**
(jinja, reasoning-preserve, chat-template-file, mmproj + path + GPU-offload
toggle, load mode, verbosity — minimum 3, same as the web: lower levels
make `llama-server` drop the log lines the dashboard parses; older
profiles below 3 are clamped up on load), **raw** (escape-hatch arg string). The **command preview is
resolved server-side** (`POST /api/preview-command`, the same endpoint the
web UI uses), so the CLI and the browser can never disagree about what
will actually launch. With `n`, if a model is already running, the form prefills
from its live `launchConfig` — **every** field, so KV quants, the spec
stack, sampling and jinja all carry over (a 262k f16-KV launch prefills
as the q8_0-KV launch it really was). The group-tab line shows which
profile the form came from (`profile: X (edited — p saves)` once changed).

| Key | Action |
|---|---|
| `↑/↓` (or `j/k`) | move between fields |
| `Tab` / `←` | next / previous field group |
| `Enter` / `→` | edit the focused field (lists fuzzy-filterable; toggles flip in place) |
| `p` | save profile (prompts for a name; offers the loaded profile's) |
| `/` | flag reference for the selected build (fuzzy-filterable; `Enter` inserts the flag into raw args) |
| `space` / `Enter` | on a device row: enable / disable it |
| `+` / `-` | on a device row: share up / down by 5 |
| `e` | on a device row: type its share (blank = auto) |
| `[` / `]` | on a device row: move it earlier / later in `-dev` order |
| `v` | on a device row: next backend for that card (e.g. `CUDA0` → `Vulkan0`) |
| `S` | suggest split: shares in proportion to free VRAM |
| `w` | start/stop the focused RPC worker row (else the first enabled worker) over SSH (y/N confirm; `POST /api/worker/*` `{worker}`, same as the web worker rows; a failed start shows the server's error incl. the worker's startup log tail) |
| `L` | worker logs overlay for that worker — last 50 lines from `POST /api/worker/logs`, refreshed every 3 s while open (`Esc` closes) |
| `b` | review this config (screen 2), then launch |
| `x` / `R` | stop / restart the model server (y/N) |
| `Esc` or `l` | back to the profiles |

**Strata editor** (`e` on a Strata profile, `N` from the profiles; 2026-10-17)
— the web's *Strata config* group as rows: **Base config** (a list of every
`strata-*.json` the dashboard lists, `GET /api/strata/configs`, the current
install first), **Max context**, **KV type** (int8 / fp16 / q4_0 / k8v4),
**KV resident**, **Spec n**, **Spec min-p**, **Pipeline windows** (0 off, 1,
2), **Resident GiB** (`--resident-budget-gib`), **GPUs** (`0`, `0,1`),
**Layer split** (`auto`, or the first layer of each later card: `27`),
**Stage trim** / **Kernel copy** (env `STRATA_STAGE_TRIM=1` /
`STRATA_HIP_ADAPT_KERNEL_COPY=1`), **RoPE scaling / scale**, and **Temp /
Top-k / Top-p**. A field left blank keeps the base file's value, shown as
`base: 3` (the configs answer's `settings`). The line under the rows names the
install and whether its launcher runs the server with THP off (Strata
0.1.44.1's `queue-serve.sh`). Typed values are checked as you commit them
(numbers in range, card numbers, the layer-split rule); the rest — a flag the
base config's engine does not have, a layer split that does not match the
cards — is the dashboard's call, shown in red where the command preview goes
(`POST /api/preview-command`, which merges the overrides into its copy of the
base file; nothing starts). `p` saves the profile (its tuning note and `needs`
are kept, `rawCommand` is not), `b` reviews and launches it like any profile,
`d` / Backspace puts the focused field back to the base value, `Esc` returns to
the profiles.

| Key | Action |
|---|---|
| `↑/↓` (or `j/k`) | move between fields |
| `Enter` / `→` | edit the focused field (base config and the fixed choices are lists) |
| `d` / Backspace | back to the base config's value |
| `p` / `b` | save as a profile / review and launch |
| `x` / `R` | stop / restart the model server (y/N) |
| `Esc` or `l` | back to the profiles |

**Devices** — the **hw** group is the web device table as rows:

- **One row per physical card** from `GET /api/devices?build=` `cards`,
  labelled from that answer's `topology`. The dashboard probes a build's
  devices only while nothing is running on a local card; otherwise (and when
  a probe fails) it answers from its cache with `cached: true`, and a dim
  line under the table says how old the list is and why. The CLI never asks
  for a re-probe (`?refresh=1`): there is no key for it. A build with two backends lists one
  card twice (`ROCm1` and `Vulkan1`); that is one row, and `v` switches the
  backend (default: the server's `preferredId`). Identical cards are
  `… #1`, `… #2`, and a profile saved for the second one stays on the second
  one — also on a build that lacks its saved id, where the row is moved to
  that card's id in this build and a warning says a choice was made. Between
  identical cards the server pairs ids across backends by order (llama.cpp
  does not say which is which); `v` says so when it applies. A profile the
  server re-pointed for this machine (`availability.devices`: ids that moved,
  a stand-in card) opens with that list instead of the saved one. Each
  row shows free/total VRAM on terminals ≥ 120 columns.
  **One row per configured RPC worker** comes from `workers`
  (`dashboard.config.json` `rpcWorkers`).
- Row order is `-dev` order, and so `-ts` order: layer split hands layers
  out in that order. Each enabled row shows its share and normalized %. With
  only some shares set the split is `auto`, meaning no `-ts` and
  llama-server divides layers by free VRAM. **Suggest split** (`S`, or Enter
  on its row) sets shares from each card's free VRAM. **Split mode** (shown
  with two or more enabled devices; Enter on its row) switches `layer` /
  `tensor`. It is stored in the config's `splitMode` field once the server
  has answered a preview with one (servers from 2026-10-12), else as
  `-sm tensor` in the raw args, which every server reads. A worker's comes from
  telemetry, which only reports it while a launch uses it; otherwise it's
  estimated from the others and says so.
- The config sent is an ordered `devices` list: `{ id, name, vramMib, share,
  enabled }` for cards (`vramMib` is the card's size, which lets the server
  offer a stand-in on a machine without that card) and `{ worker, share,
  enabled }` for workers.
  Disabled rows stay in profiles as `enabled: false`. The server assigns
  worker ids (`RPC0`, …) and starts every enabled worker's
  `ggml-rpc-server` at launch. **Transport** (`WiFi` / `TB4` / `WAN`) is
  shown and sent only while a worker row is enabled.
- **Worker rows** show a status badge (`RUNNING` / `STOPPED` / `OFFLINE` /
  `ERROR`), polled every 5 s via `POST /api/worker/status {worker}`. Polling
  runs only for enabled worker rows while Launch mode is open.
- **You don't need to start workers before launching.** Launching calls
  `/api/start`, which starts each enabled worker over SSH if needed and
  waits up to ~25 s for its RPC port. Launch shows `launching (starting RPC
  worker laptop if needed)…` meanwhile.
- **Draft device** (spec group) offers only enabled *local* devices, so MTP
  drafting never round-trips the network. Anything else is sent as default.
- **Older configs** (profiles, a running launch) that still carry
  `deviceA`/`deviceB`/`rpcTarget`/`tensorSplit` are converted through
  `POST /api/preview-command`, which is also how the server re-points an id
  whose card moved (e.g. the XTX `Vulkan0` → `Vulkan1` after adding the
  3060). If the server can't be reached, they're converted locally. The
  server's warnings show above the command preview, and so does a note for
  any device saved without a card name, since those can't be re-pointed.
- The web's `rawCommand` (its raw command box) is **dropped** on load and
  never sent or saved by the CLI (the one exception is restart, which
  resends the running launch config untouched). `/api/start` runs a non-empty
  `rawCommand` verbatim and ignores every structured field, so a stale one
  would silently override your edits. Unknown keys are dropped too.

- **Mouse** — profile rows (a click selects; launching stays on the
  keyboard), the editor's group tabs, field rows, and toggle fields are
  clickable (the mode tabs up top are clickable in every mode). Left-clicks are
  matched under both SGR button conventions (0 = left, and the X11-style
  1 = left that some terminals report), so clicks work in either. While
  a text-field editor is open, terminal mouse tracking is suspended so
  the terminal's own middle-click primary-selection paste works there
  too (instead of the click being reported into the field as text).

Profiles are **shared with the web dashboard** and stored server-side
(`GET/POST/DELETE /api/profiles`, file `logs/profiles.json` on the
dashboard host) — a profile saved in either front end shows up in both,
and both stamp a "last used" time when a profile is applied (the CLI: when
it is launched or opened in the editor). The CLI's
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
  feeds back (top 5 results: title, url and a short snippet each), plus a
  `web_fetch` tool that reads one page (`POST /api/web-fetch`: its readable
  text as markdown, capped at 12,000 characters; public sites only, never the
  LAN). `/searches N` sets how many web calls (searches and fetches together)
  an answer may use, same as the web chat bar's number: `0` = off, `N` = up to
  N, `-1` = unlimited (`^w` flips between off and the last non-zero setting).
  Past the limit the model gets a "limit reached" result and answers from what
  it has. The tool exchange is kept in context so citations stay grounded.
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
| `^w` | web search off / back to the last setting (default unlimited) |
| `/new` | clear the conversation |
| `/model` | show the running model |
| `/temp <0..2>` | set the temperature for this session (`/temp reset`: model default) |
| `/think` · `/web` · `/show` · `/hide` | set thinking level · web search on/off · thinking display (`thinking`/`full`) · hide thinking |
| `/searches <n>` | web searches per answer: `0` = off, `n` = up to n, `-1` = unlimited |
| `/m` · `/l` · `/1`../`/3` · `/exit` | jump to Monitor / Launch / that tab / quit the TUI |
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
                                 # mapping (device list <-> config, legacy
                                 # conversion via preview, catalog merge,
                                 # shares/suggest split, rawCommand
                                 # sanitizing, verbosity floor), telemetry
                                 # panels + grid layout, store, ink renders
                                 # (N-device Monitor, device rows, worker
                                 # polling gate), chat helpers (thinking
                                 # kwargs, image attach, tool replay),
                                 # Launch flow against a fake dashboard
                                 # (profile list + markers, confirm panel,
                                 # busy cards / 409 CARD_BUSY -> force,
                                 # stop / restart confirms), machine
                                 # topologies (test/topology.test.js: one
                                 # card, two identical cards, mixed vendors,
                                 # CPU-only, a remote worker -- labels,
                                 # availability order, override, split mode,
                                 # per-card Monitor panels)
bash test/live-cycle.sh        # full end-to-end launch cycle against the
                                 # LIVE dashboard: STOPS the current model
                                 # for ~1-2 min, then restores it. Never run
                                 # it while the benchmark queue is using the
                                 # cards -- `npm test` touches no server.
```

## Architecture

```
cli.js                 entry: TUI bootstrap + non-interactive subcommands
src/client.js          HTTP + SSE client (reconnect w/ backoff, idle watchdog
                       keyed off the server's 15s `: ping` heartbeats)
src/state.js           external store: SSE events + telemetry poller ->
                       rolling buffers, live progress, completions, log tail
src/profiles.js        shared profiles via /api/profiles (server-side)
src/topology.js        pure: the machine as the server describes it (cards,
                       workers, signature) -- card labels, placement text,
                       profile availability, telemetry reading -> card
src/launchconfig.js    pure draft <-> launch-config mapping (ordered devices,
                       legacy conversion, catalog merge, share/suggest-split
                       and row edits, split mode, profile sanitizing,
                       sort/tag/summary)
src/launchplan.js      pure helpers for the profile-first flow: profile ->
                       list row (availability, placement) / launch body,
                       list order, filter, busy-card list, split mode,
                       running summary, what needs a second confirmation
src/format.js          formatting + telemetry panel/grid helpers
src/config.js          ~/.llama-cli/config.json
src/app.js             mode router, global keys, input gating, help overlay
src/modes/monitor.js   Mode 1
src/modes/launch.js    Mode 2 (profiles -> review -> launch; config editor)
src/modes/chat.js      Mode 3 (streaming chat: image attach, thinking
                       levels, web-search tool loop, middle-click paste)
src/components/        sparklines, bars, fuzzy list, status bar, help,
                       launchviews (running line, profile list, confirm panel)
```

No JSX, no build step — `React.createElement` via the `h` alias in
`src/h.js`, plain `node cli.js`.

The old proof-of-concept (raw ANSI renderer, its own `llama-server`
spawner, 5s poller) is preserved in `legacy/` and is superseded.

## Notes / known limits

- Uptime (status bar and Launch's top line) only counts when the TUI
  observed the start→ready transition: the SSE stream carries no start
  timestamp for a model that was already running (`loadStartTime` is zeroed
  once the model is ready), so Launch shows `uptime unknown` then. The store
  already reads a `startedAt` (ms epoch) field from the status frame if the
  dashboard ever sends one.
- Renaming or duplicating a profile marked `MISSING` is refused: the
  dashboard checks the model path on every profile save (`Model path not
  found`). Deleting it works.
- `?` is not available on the review screen (it owns the keyboard, like
  any confirmation); its keys are on its bottom line.
- Restart and "launch while another server runs" are two requests from the
  CLI (`/api/stop`, then `/api/start`); if the second fails the server stays
  stopped and the message says so.
- The profile list's context column is `—` for a Strata profile whose base
  config the dashboard does not list with a `maxContext` (the context lives
  in the base config file).
- Per-request GPU sample sparklines (the "omni" graph) need
  `/api/logs/samples` — not wired into the TUI.
- Chat mode hits the dashboard's `POST /api/chat` (a streaming pass-through
  to `llama-server`), not the model port directly — so it works through a
  tunnel and the server's client-agnostic capture still records every
  request to the benchmark CSV regardless of which client sent it.
