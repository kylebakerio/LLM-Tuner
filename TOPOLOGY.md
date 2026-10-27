# Hardware topology

How LL-Dash models the machine it runs on, what a saved profile has to say to
run on another machine, what it has actually run on, and what is still tied
to one machine. Written 2026-10-12, when the dashboard moved from an RX 7900
XTX + RTX 3060 to two identical RX 7900 XTX and had to stop naming either;
revised 2026-10-13 (device probes, path roots, the setups it has run on).

The rule: **no code names a card, a vendor's product, or a device id.** Names
come from detection (`llama-server --list-devices`, `monitor.py`), from the
records themselves, or from configuration.

## The model

`lib/topology.js` (pure, tested in `test/topology.test.js`) builds one
description of the machine:

```
GET /api/topology
{ cards: [ { key, name, short, label, vendor, ordinal, count, vramMib, ids, preferredId, orderAssumed } ],
  hostRamMib, workers: [...], signature: "2x RX 7900 XTX 24G | 63G RAM" }
```

- **A card is a physical card.** llama.cpp lists a card once per backend
  (`ROCm1` and `Vulkan1` are one card in a ROCm+Vulkan build); `ids` holds
  every id that reaches it, `preferredId` the one to use by default (the
  vendor backend, then Vulkan).
- **Identical cards are two cards.** `key` is the card name plus its ordinal
  among identical cards (`amd radeon rx 7900 xtx#2`); `label` is what the UI
  shows (`RX 7900 XTX #2`; a single card has no number).
- **`orderAssumed`.** Nothing in `--list-devices` says which Vulkan id is which
  ROCm id, so identical cards are paired across backends by listing order. The
  flag is set where that pairing was needed. Telemetry makes the same kind of
  assumption: `monitor.py` reports cards by PCI address, and the k-th reading
  of a card model (by PCI address) is taken to be card #k. On the machine this
  was written on that pairing has not been verified against a real load on
  each card.
- **Per build.** Each configured build has its own device list. The topology
  of the fullest listing is "the machine"; a launch uses the topology of its
  own build, with the fullest one as the reference for ids its build lacks.
- **RPC workers** are other machines' cards. They are listed in `workers`,
  never in `cards`.
- **No GPU** is a valid machine: `cards: []`, `signature: "no GPU | 63G RAM"`.

Callers:

| Question | Function | Used by |
| --- | --- | --- |
| Which card does this id reach? | `cardOfId` | everything below |
| Can this saved profile run here? | `availability` | `GET /api/profiles` |
| What devices will this launch really use? | `launchDevices` | `/api/start`, `/api/preview-command` |
| May this launch start here at all? | `launchGate` | `/api/start` (409 `UNAVAILABLE_HERE`) |
| Do two launches share a card? | `cardKeysOf` | `lib/launchguard.js` |
| Where does a launch sit, in words? | `placementLabel` | launcher, picker |
| Which cards is a queue lane on? | `laneCards` | `/api/queue`, `/api/lanes/live` |
| Which telemetry reading is which card? | `lib/telemetry.js` `labelGpus`, `mapDevicesToGpus` | monitor |

The browser's share of the wording lives in `ui/topology/view.js`
(`test/topoview.test.js`); `lib/runlabel.js` names the devices of recorded
runs.

## Profiles

A profile's fit on a machine is one of:

| Status | Meaning | Launcher |
| --- | --- | --- |
| `ready` | runs as saved | listed first |
| `moved` | same cards, other ids here | loads and launches the re-pointed ids, says so |
| `substitute` | a card this machine lacks, stood in for by one at least as big | loads the stand-in, marked "not validated" |
| `unavailable` | needs hardware this machine does not have | folded away with the reason; asks before loading |

### What a portable profile says

- **Devices by card, not only by id.** Each local device carries
  `{ id, name, vramMib, share }`. `name` lets the id follow the card to
  another machine; `vramMib` lets a machine without that card offer one at
  least as big. The web UI saves both. A device with only an `id` (a bare id)
  runs where that id exists and means the same thing -- with one defined
  fallback, below.
- **Paths that are not one user's home directory.** `modelPath`,
  `specDraftModel`, `mmprojPath`, `chatTemplateFile`, `strataBase` and the
  paths inside a `rawCommand` may be written `~/...`, `${NAME}/...` (a root
  from `dashboard.config.json` `pathRoots`, else an environment variable;
  `${MODELS}` is `modelsRoot`), and a model path may be relative to
  `modelsRoot`. See "Configuration". An absolute path means what it always
  did.
- **`needs`** for a profile whose launch lists no devices (an engine with its
  own launcher): `{ vendor, minVramMib, minCards, hostRamMib }`. Without it
  such a profile reads as runnable everywhere.
- **`splitMode`** (`"tensor"`) rather than `-sm tensor` in the extra
  arguments. Both work; the field is the one the form understands.
- **No device ids in `argString`.** `-ot 'blk\.(24|25)\.ffn=CUDA0'` pins
  tensors to an id. Such ids are checked (a profile whose `argString` names an
  id this machine lacks is `unavailable`) but never rewritten: a substitute or
  moved launch keeps the text as saved.
- **No `rawCommand` as the thing to run.** A raw command is run verbatim:
  nothing in it is re-pointed.

### A bare id this build does not list

`{ id: "ROCm1" }` with no card name, launched on a build whose device list has
no `ROCm1` (a Vulkan-only build of the same machine), says nothing about which
card was meant -- except through the machine's fullest listing. The rule
(`resolveDevices`, decided 2026-10-13):

- If the fullest listing knows the id as a card (`ROCm1` = `RX 7900 XTX #2`),
  and this build reaches that same physical card (as `Vulkan1`), the device
  moves there: status `moved`, with the note "ROCm1 is RX 7900 XTX #2 on this
  machine, which this build reaches as Vulkan1 (identical cards paired by
  listing order)". The device gains no `name` it was not saved with.
- Otherwise it is `unavailable`: no fuller listing, an id that listing does not
  know either, a card this build cannot reach at all, or that card already
  taken by another device of the same launch.
- It is never placed by its number (`ROCm1` is not "the second device of
  whatever this build has") and never on the first free card. A wrong guess
  there loads a model onto the card another launch is using.

The pairing it relies on is the `orderAssumed` one, so on identical cards the
note says so.

### The launch gate

`POST /api/start` refuses a launch this machine cannot run (`launchGate`):
`409 { code: "UNAVAILABLE_HERE", availability: { status, reason } }`. What is
checked is what will run: the raw command's device ids when the request
carries one, else the saved device list and the ids in the extra arguments,
plus `needs` when sent. An engine with its own launcher names no device id,
so for it the gate has two things: the card count its own config asks for (a
Strata config with `"gpu": [0, 1]` needs two cards; it used to be run on the
first card of a one-card machine), and the `needs` the request carries -- the
web launcher sends the loaded profile's; a caller that sends none is not
checked for memory or card size. `moved` and `substitute` are not refusals. A caller
that has asked its user repeats the request with `allowUnavailable: true` (its
own flag: `force` remains the busy-card answer; neither is stored). With no
card known -- the device probe has not answered, or the machine has no GPU --
nothing is refused: the gate claims nothing it cannot see.

### What is deliberately not done

- A `substitute` is never validated. A bigger card of another vendor, another
  backend or another memory layout can still fail to load or run slower.
- `bench · ` profiles are the exact configs behind scored benchmark rows.
  Their stored placement is not edited; on a machine that lacks their cards
  they are `unavailable` (or load re-pointed in the form, leaving the store
  untouched).

## Device probes

`llama-server --list-devices` (and `--help`: llama.cpp loads every backend
before it prints usage) initialises every backend on every card. A probe that
landed while a two-card engine was decoding stalled it, three times out of
three (2026-10-12), and `/api/devices` used to probe on every call. The rule
now lives in one place (`lib/deviceprobe.js`, `test/deviceprobe.test.js`):

- A probe runs at boot, on an explicit refresh (`GET /api/devices?refresh=1`;
  the launcher's "probe now" link, which asks first when the cards are busy),
  or while nothing is on a local card.
- "Something on a local card" is: a model this dashboard launched, a launch or
  benchmark in progress, a running queue item on a `local-*` lane, another
  server on the managed port, or a card that telemetry shows loaded (3 GB of
  VRAM in use, or 30% utilisation) -- the last is what sees work the dashboard
  did not start.
- Otherwise the cached listing is served with its age (`cached`, `cachedAt`,
  `ageMs`, `note`).
- A probe that fails or times out never replaces or hides a good earlier
  listing: the last good one is served, with `error` beside it.
- A build with no listing of its own is shown the fullest listing another
  build has, marked `borrowed` (the same cards, possibly ids this build
  lacks); a launch is not re-pointed against a borrowed list.
- The good listings are kept in the dashboard's own `logs/device-cache.json`.
  A restart with something on a local card serves them and probes nothing it
  already knows; otherwise boot probes each build, one at a time.

Not covered: codebench's lane runners run `$STOCK --list-devices` themselves
when they start (`tools/queue_runner.py` `gpu_devices()`); restarting a lane
runner is a probe.

## Monitor

`monitor.py` reports every GPU of this machine with its own PCI address, and
for AMD cards reads power, temperatures and fan from that card's own hwmon
directory (matched by PCI address, so two identical cards never share a
sensor). The server labels each reading with its card (`label`), maps a
launch's devices to readings by physical card, and the page draws one bar,
one legend entry and one chart line per card.

## Queue lanes

Lane names are not hardware. A lane's cards come from its own
`runtime_json`: `devices` (llama.cpp ids when the lane serves on this
machine) and `gpu` (the card name a runner published). By the queue's
convention `local-*` lanes run on this machine and any other lane with a card
is another machine's. A lane that is paused with no live runner, or set up for
cards this machine does not have, is `parked` and folded away in the queue
view.

The queue's "new item" presets turn a saved `bench · ` profile into a launch
command (`lib/recipes.js`). The two scored recipes are recognised by their
shape -- one local device with the draft model on it; two local devices on two
different cards at 75 / 25 with the draft on the first -- and the ids in the
command are the profile's own, so the recipe is the same recipe on a second
identical card or on another machine's ids. `$D27MTP` is only said to be a
profile's placement while the variable's own `-dev` / `-ts` agree with it;
when they do not (the variables file moved to another card pair on
2026-10-12), the preset says so in its note. Which lane a one-card profile
goes to, and which build `$STOCK` is, come from `dashboard.config.json`
`queue` (below), not from a device id.

## Recorded runs

`lib/runlabel.js` turns `-dev ROCm0,CUDA0` in a recorded launch into card
names. The names come from the machine THE RUN was recorded on, never from
the machine that reads it, in this order:

1. the record's own machine: `server.machine.gpus` in a result JSON; for a
   logged request, the `machines` row its `machine_fp` points at. The name
   where it is a product name, and how many identical cards that machine had;
2. the record's own device list: what the dashboard listed for each device id
   when the request ran (`requests.devices_json`). It names any id, Vulkan
   included; it does not say how many such cards there were, so an id named
   this way is not numbered;
3. this machine's device list (from the server's cache; naming a record never
   probes a binary) -- but only where it can speak for the record. A record
   made on other cards (another count, other memory sizes), one whose own
   device list names a device this machine does not have, and a record made
   on another machine are not described by the cards that are here now;
4. `deviceNames` in `dashboard.config.json`: names for ids nothing above can
   name -- a card that has left the machine, or a process that has no device
   list (the public site builds its catalog in its own process and reads this
   key itself). They are this machine's names: they never name a card of
   another machine, and never an id the record's machine had no card for;
5. nothing: the id is shown as the id.

**Another machine.** `CUDA0` has meant the RTX 3060 on the desktop and the
RTX 4090 on the laptop on the same day. A record is another machine's when it
says so (`server.remote`, a codebench remote lane) or when its machine record
carries a host that is not this one (`os.hostname()`). Such a record is named
from sources 1 and 2 only, and the label says which machine it was:
`laptop: RTX 4090 Laptop only`, `laptop: RTX 4090 Laptop + RTX 3060 (split
2:1)`. The machine's name is `machineNames` in `dashboard.config.json` when
it has an entry (by fingerprint, host or lane), else the host its record
carries, else the lane. A queue item on a lane that is not `local-*` is
marked the same way while it waits for its first result
(`lib/codebench.js` `queueServer`): its ids stay ids, under the lane's name.

**The catalog's speed labels** (`speed.curve.byConfig[].label`, lab and
public) group requests by launch command, and one command has run on more
than one machine record: the desktop before and after its second card, and
rows from before machines were recorded. Each distinct record gets its label
and the config gets one (`mergeDeviceLabels`): the records' label when they
agree; when they differ only in which twin (`#1`, `#2`), the label without
the number; when they name different cards, each, most requests first, joined
with ` / `. A row with no record never outvotes a record. The label is not
part of any key: a config's `id` is its launch command alone.

Until 2026-10-13 those labels were made from the launch command with no
machine at all, so every laptop run read `RTX 3060 only` (this machine's
configured name for `CUDA`) and the laptop's two-card run `2x RTX 3060 (split
2:1)`, on the lab page and on the public site.

Limits:

- The harness records AMD cards under their PCI-database name
  (`Advanced Micro Devices, Inc. [AMD/ATI] Device 744c`), which is not a
  product name. Such a record says how many cards the machine had and how
  big they were; the name comes from the next source. On another machine's
  record there is no next source: its AMD card reads as its id
  (`laptop: ROCm0 only`) until the harness records a product name.
- A record with no machine information and no device list (older runs) is
  named from this machine's device list as it is today. An old single-card run
  on `ROCm0` therefore reads `RX 7900 XTX #1 only` on the lab dashboard of a
  machine that now has two (the public site, with no device list, reads
  `RX 7900 XTX only`). Such a record is also still read as THIS machine's:
  a laptop launch with nothing recorded would take this machine's names.
- A process without a device list cannot number identical cards it has no
  record of: there a Vulkan id on a two-card machine reads `RX 7900 XTX only`.
- "This machine" is its hostname. Renamed, its own older records read as
  another machine's (`pop-os: ...`, AMD cards as ids) until `machineNames`
  or the hostname says otherwise.

## Configuration

`dashboard.config.json` (gitignored; `dashboard.config.example.json` is a
neutral starting point that works unchanged on a machine with llama.cpp built
in `~/llama.cpp/build` and models in `~/models`). Every key is optional.

| Key | What it is |
| --- | --- |
| `pathRoots` | `{ "NAME": "path" }`: roots usable as `${NAME}` in any path below and in profiles. A root may use `~`, an earlier root, or an environment variable. |
| `modelsRoot` | Where this machine keeps models. Scanned for `/api/models`; `${MODELS}`; what a relative model path in a profile is under. |
| `llamaServerBuilds` | `[{ id, label, path }]`: the llama-server binaries. `id` is a per-machine name: a profile's `build` only means something where that id is configured. |
| `modelDirs` | More directories to scan for models. |
| `rpcWorkers` | Other machines' cards, by name. `binary` / `logFile` are paths ON the worker and are not expanded here. |
| `strataInstalls` | Strata install directories (or `{ dir, label }`), the current one first (it is the "current install" the launch form and the CLI name; 2026-10-17 on this machine: 0.1.44.1, then 0.1.43.1, then 0.1.32). None = no Strata on this machine. `STRATA_DIR` in the environment is still honoured and comes first. A config always launches through its own install's `queue-serve.sh`. |
| `deviceNames` | Names for device ids that recorded runs use and this machine can no longer name (a card that has left). Display only. |
| `machineNames` | `{ "<fingerprint, host or lane>": "<name>" }`: what a label calls another machine (`laptop: RTX 4090 Laptop only`). Without an entry it is the host the run's machine record carries, else the lane. Display only. |
| `modelDisplayNames` | A model key or family shown under another name. |
| `internalRowVariants` | Row variants (`<model>~rv:<slug>`) left out of the catalog on the lab dashboard and the public site. The data stays where it is. |
| `reliabilityNotes` | `[{ id, devicesMatch, note }]`: hardware notes shown on configs whose device list matches the pattern. None are built in. |
| `queue` | `stockBuild` (the build id `$STOCK` is; default: the build whose path equals `$STOCK`), `laneByCard` (`{ "<card name or id>": "<lane>" }`), `envFiles` (the launch-variable files). |
| `remoteAccess`, `llamaHost`, `liveChatTapPort` | As before; `tunnelConfig` / `passwordFile` take `~` and `${NAME}`. |
| `codebench` | `{ root, python, lock }`: the benchmark checkout (default `~/code/codebench`; `root` takes `~`, not `${NAME}`). |

No tool outside this directory reads the config or the profile store (checked
2026-10-13: codebench's tools, the sweep scripts and `monitor.py` do not), so
a portable spelling in either is seen only by code that expands it.

Paths: `~` at the start, `${NAME}` anywhere, and nothing else is touched -- a
path that starts with `/` and holds no `${` is used byte for byte
(`lib/paths.js`, `test/paths.test.js`). A `${NAME}` nothing defines is left as
written, so the "not found" message names the variable. Profiles are served
(`GET /api/profiles`) with their paths expanded, and a save that sends back
the expansion of a stored portable path keeps the stored spelling; a profile
stored with absolute paths is never rewritten. `tools/migrate-profile-paths.js`
prints (and, when asked, writes to a NEW file) the portable spelling of an
existing profile store.

## Setups this has run on

Every real machine layout found in the records of the lab this was written in, oldest first, with how
the model above describes it. Each is a fixture in `test/setups.test.js`, so the model is exercised
against all of them and not only the machine on the desk. Numbers carry their source; "unverified"
and "not re-measured" are the source's own words. Paths are relative to this directory unless they
start with `~`.

Two things hold for all of them:

- A listing belongs to a build. The same machine listed its cards as `CUDA0` / `Vulkan0` / `Vulkan1`
  under one build and `CUDA0` / `ROCm0` / `Vulkan0` / `Vulkan1` under another.
- An id belongs to a machine and a date. The one RX 7900 XTX has been `Vulkan2` (laptop enclosure),
  `Vulkan0`, `Vulkan1` and `ROCm0` (desktop); the one RTX 3060 has been `CUDA0` (desktop) and `CUDA1`
  (laptop enclosure); `CUDA0` has meant the RTX 4090 on the laptop and the RTX 3060 on the desktop on
  the same day. Only a device saved with its card `name` survives that (`moved`); a bare id either
  stops resolving or, worse, resolves to another card.

### Two laptops over llama.cpp RPC (2026-07): local Wi-Fi, then a direct Thunderbolt cable

The first setup. The hardware is as described by the owner; the records below agree with it but never
name the machines, and their measurements are few and unreliable.

- **Hardware and link.** A ThinkPad X1 Gen 4 and a ThinkPad P1 Gen 6, each with a 16 GB NVIDIA laptop
  card, joined by llama.cpp RPC: briefly over local Wi-Fi ("surprisingly usable"), then over a direct
  Thunderbolt-to-Thunderbolt cable (owner's description, given 2026-10-12). The records call the two
  machines "the 3080" (192.168.1.120, the master) and "the 4090" (192.168.1.125, the worker: the RTX
  4090 laptop of every later setup). `llama-server` and `ggml-rpc-server` ran in Docker
  (`../Dockerfile.rpc`, `../docker-compose.master.yml`:
  `--rpc 192.168.1.125:50052 --split-mode layer --tensor-split 1,1`). The dashboard's first commit
  (2026-07-14) had a Transport select for the link, "Wi-Fi / LAN" or "Thunderbolt 4"; choosing
  Thunderbolt pointed the worker at a link-local address (169.254.x.x), i.e. the direct cable.
  Which ThinkPad held which card is not written anywhere.
- **In the model.** One local card and one entry in `workers`; the other laptop's card is never one
  of this machine's cards. Signature `RTX 3080 Laptop 16G` in the fixture (host memory is not in the
  records). The launch is `[{ id: 'CUDA0' }, { worker: <name> }]`, placement
  `<card> + <worker> (RPC), 1:1`. Wi-Fi and the cable are the same topology: the model does not
  describe the link, only `rpcWorkers.<name>.link` says how the worker is reached. The dashboard of
  that date knew exactly this shape ("GPU A + one RPC worker") and nothing else. No queue existed.
- **Measured.** Little that can be trusted; the early records are spotty and buggy, as the owner
  says. `../logs/benchmarks.csv` starts on 2026-07-18 and has 16 rows up to 2026-07-25. All 16 say
  Transport `WiFi`, but 15 of them say RPC `no`, so the column was the form's default rather than a
  measurement of the link. The one row with RPC `yes` (2026-07-25, Qwen3.6-35B-A3B UD-Q5_K_XL) reads
  25.7 gen tok/s on an 11-token prompt, with the same 9.9 GB on the master's card as that model's
  non-RPC rows and no worker reading, so how much of it ran on the worker is not recorded.
  `../readme.md` (notes of that month): a 35B MoE at Q4 with about 10 GB in VRAM gave 16 tok/s on the
  3080 and 21 tok/s on the 4090, each machine alone. No number for the Thunderbolt cable survives:
  no row in the CSV or in its 2026-09-13 backup (`../logs/benchmarks.csv.bak`, the same 16 July rows)
  says `TB4`, and the one such row ever logged is quoted in `updated-dashboard-plan.md` as an example
  of a broken CSV schema.
- **Pitfalls.** The fixture's device listing is constructed (no `--list-devices` text of either
  laptop from that month was kept). A CSV column that records a form's default, not what ran, is the
  reason later rows carry the launch command and a per-device reading.

### Laptop RTX 4090 + RX 7900 XTX in a Thunderbolt 4 enclosure (2026-08; again on 2026-10-11)

- **Hardware and link.** Core i9-13900H laptop, 31 GiB of memory, RTX 4090 Laptop GPU (16 GB,
  internal, 80 W firmware power cap) and a desktop RX 7900 XTX (24 GB) in a Thunderbolt 4 enclosure
  (`docs/archive/BENCH-FINDINGS-2026-09-15.md`, "Rig"). The enclosure link negotiates PCIe 3.0 x4
  (`TB4-EGPU-XTX-POST.md`). The rig moved in mid-September (the XTX into the desktop, same file); an
  XTX sat in the enclosure again for one llama-bench session on 2026-10-11, before it went into the
  desktop as the second card.
- **In the model.** Three cards, because Vulkan also lists the integrated GPU: `RTX 4090 Laptop`
  (`CUDA0`, `Vulkan1`), `Iris Xe` (`Vulkan0`), `RX 7900 XTX` (`Vulkan2` only: that build had no
  ROCm). Device names and order are captured (`../logs/bench-history.log`, 2026-08-17). Signature
  `RTX 4090 Laptop 16G + Iris Xe <n>G + RX 7900 XTX 24G | 31G RAM` (the integrated GPU's size is not
  in the records). The daily launch was `-dev CUDA0,Vulkan2 -ts 40,60`: placement
  `RTX 4090 Laptop + RX 7900 XTX, 2:3`. No queue lanes: the queue did not exist yet.
- **Measured.** Qwen3.8-27B UD-Q6_K_XL at 262k split over both cards: 26 to 28 gen tok/s, about 570
  prefill tok/s on a 22k prompt (`reddit-post-outline.md`, 2026-08). The enclosure against a desktop
  slot, same card, ROCm on both ends, everything in VRAM: prompt 841 vs 910 tok/s (-7.6%), generation
  30.7 vs 37.1 (-17%) (`TB4-EGPU-XTX-POST.md`: a draft from another assistant's session on 2026-10-11,
  not re-measured here).
- **Pitfalls.**
  - Device enumeration can hang on an enclosure in a bad power or link state; the probe has a hard
    timeout for that reason (`server4.js` `probeDevices`), and a probe that fails or times out now
    leaves the last good listing in place (`lib/deviceprobe.js`).
  - The integrated GPU is a card to the model and to `ggml-rpc-server` (`README.md`: it "serves every
    non-CPU device (the laptop's iGPU included)" unless its devices are pinned).
  - Profiles of this era stored bare ids (`deviceA: "CUDA0"`, `deviceB: "Vulkan2"`; the example in
    `API.md`, and `bench-tools/depth_sweep.py` still has `-dev CUDA0,Vulkan2`). On any other machine
    they are `unavailable`, or point at whatever card has that id now.
  - With part of a model on the CPU, activations cross the cable on every token: a 7B went from 123
    to 28 gen tok/s with 4 of 28 layers on the CPU (`TB4-EGPU-XTX-POST.md`, same caveat).

### Desktop RX 7900 XTX + RTX 3060 (2026-09-13 to 2026-10-12)

- **Hardware and link.** Ryzen 7 5800X; 32 GB of memory in mid-September
  (`BENCH-SUMMARY-POST.md`), 62.7 GiB from 2026-09-24 (run database, `machines`). Both cards in CPU
  slots at PCIe 4.0 x8 until the night of 2026-10-05; then the XTX in the top slot at x16 and the RTX
  3060 on a riser in the chipset slot at Gen4 x4 (`../HANDOFF-archive-2026-10-06.md`, "hardware change
  night"; the `machines` table has each layout).
- **In the model.** Two cards, signature `RTX 3060 12G + RX 7900 XTX 24G | 63G RAM`. The CUDA+Vulkan
  build listed `CUDA0`, `Vulkan0` (3060) and `Vulkan1` (XTX) -- captured 2026-09-13 in
  `test/devices.test.js`; the CUDA+ROCm+Vulkan build added `ROCm0` for the XTX
  (`HETERO-DEVICES-PLAN.md`). Lanes, from the end of September: `local-gpu` (takes any launch, splits included;
  publishes no device, so it reads as both cards), `local-xtx` (`devices: ["ROCm0"]`), `local-3060`
  (`devices: ["CUDA0"]`), `cloud`, and from 2026-10-06 the remote `laptop-4090`.
- **Measured.** One card before a split: Qwen3.8-27B UD-Q4_K_XL at 128k on the XTX alone generated
  36.5 tok/s over 3,062 real requests against 31.3 split 5:1 over both cards, which prefilled faster
  (539 vs 493) (`~/code/ai-lab-posts/posts/speed-on-a-mixed-gpu-desktop.md`). The slot move cost
  nothing: XTX x8 to x16 no change, the 3060 on the x4 riser 14 to 17% faster, cause not isolated
  (`~/code/ai-lab-posts/posts/speed-oddities.md`).
- **Pitfalls.**
  - Without `GGML_BACKEND_DL=ON` the CUDA and HIP backends collide in one build and "the 3060
    silently reappears as `Vulkan1`" (`reddit-post-2026-09.md`).
  - Tensor overrides take the first match: an `-ot ...=CUDA0` placed after `-ncmoe` moved nothing, and
    for a week every "tuned" two-card launch had no experts on the second card (found 2026-09-28;
    memory note `override-order-first-match.md`). Check placement from the load log, not the command.
  - A card can leave the listing while the machine stays up: the XTX dropped off the PCIe bus twice on
    2026-10-06 and stayed gone until a power cycle (`~/code/ai-lab-posts/posts/xtx-dropping-off-the-bus.md`).
    The run database has a machine record from that morning with the RTX 3060 as the only GPU.
  - The RTX 3060's server died in cuBLAS on the CUDA 12.0 build and has not on the CUDA 13.3 one
    (`~/code/ai-lab-posts/posts/rtx-3060-cublas-crash.md`): which build a profile names mattered.
  - The boot console lands on the NVIDIA card; a monitor on the other card stays black
    (`../HANDOFF.md`, "Hardware").

### Desktop + the laptop's RTX 4090 as an RPC worker (Wi-Fi 2026-09-14; direct 1 GbE 2026-09-26)

- **Hardware and link.** The desktop above, plus the laptop running a bare `ggml-rpc-server -d CUDA0`
  (no Docker; `README.md`). First over Wi-Fi (192.168.1.125), then over a direct cable between two
  USB Ethernet adapters (10.10.10.1 and 10.10.10.2, about 107 MB/s, 0.27 ms; memory note
  `rpc-laptop-4090.md`).
- **In the model.** The worker is `workers: [{ name: "laptop", ssh: "laptop", port: 50052, devices:
  "CUDA0", link: "ssh" }]` (`dashboard.config.json` `rpcWorkers`) and never a card: the signature
  stays `RTX 3060 12G + RX 7900 XTX 24G | 63G RAM`, and a launch on the XTX and the worker holds one
  local card. A device is `{ worker: "laptop", share }`; llama.cpp calls it `RPC0`, an id the
  dashboard assigns and a profile never stores. `README.md`'s three-device example
  (`-dev Vulkan1,RPC0,CUDA0 -ts 50,30,20`) reads `RX 7900 XTX + laptop (RPC) + RTX 3060, 5:3:2`. A
  profile that names a worker is `unavailable` on a machine whose config has no worker of that name.
- **Measured.** Wi-Fi: 7.7 gen / 226 prefill tok/s for a 27B that does 76.2 / 671 on the XTX alone;
  the link saturates at about 180 Mbit/s and loading took 78 s against about 5 s. Adding the RTX
  3060 as a third device changed nothing (8.1 / 227)
  (`docs/archive/BENCH-FINDINGS-DESKTOP-2026-09.md`, batch 9). 1 GbE: 23 to 24 gen tok/s with any
  layers of Qwen3.8-27B UD-Q4_K_XL on the worker, against 36.5 for the local two-card split and 52 to
  57 on the XTX alone (memory note `rpc-laptop-4090.md`; listed as "unverified, from 2026-09 notes"
  in the mixed-GPU post).
- **Pitfalls.**
  - The worker binary must speak the server's RPC protocol version: a v5 worker against a v7 server
    was one of two things that blocked the three-device rows
    (`docs/archive/BENCH-FINDINGS-DESKTOP-2026-09.md`).
  - `RPC0` must not be the last device in `-dev` (the load asserts on `output.weight`), and `--rpc`
    must come before `-dev` (`README.md`, `../sweeps/rpc-pool/README.md`).
  - MTP drafting over RPC halves throughput (20.2 tok/s without, 7.7 to 8.1 with, on Wi-Fi).
  - `ggml-rpc-server` has no authentication: bind it to the private link.
  - The laptop's USB adapter sits behind its Thunderbolt port; the whole USB bus disconnected under
    load once (2026-09-26). Later judged a one-off.
  - The "experts on the worker" result for Flash-Next from that day is invalid (a dead `-ot`).

### The laptop as a remote queue lane over ssh (`laptop-4090`, since 2026-10-06)

- **Hardware and link.** The same laptop, but nothing is split: `llama-server` runs on the laptop,
  and the desktop's lane runner tunnels to it over ssh while the proxy, harness and agent stay on the
  desktop (codebench `tools/laptop-llama-server.py`). Each launch takes the direct 1 GbE link if it
  answers, else Wi-Fi.
- **In the model.** Not a card and not a worker: a lane whose `runtime_json` is
  `{ devices: ["LAPTOP4090"], gpu: "NVIDIA GeForce RTX 4090 Laptop GPU" }`. `laneCards` answers
  `{ label: "RTX 4090 Laptop", here: false, remote: true, cards: [] }`, and the launch guard never
  counts it against a local card. Its items are written in the laptop's terms (`-dev CUDA0` is the
  4090 there; on the desktop of the day `CUDA0` was the RTX 3060). The laptop's own topology is one
  card, `RTX 4090 Laptop 16G | 31G RAM`; the run database records it as a separate machine.
  A recorded run from this lane is named from that machine record: `-dev CUDA0` reads
  `laptop: RTX 4090 Laptop only` (see "Recorded runs").
- **Measured.** Qwen3.8-27B GSQ-RCO IQ2_XS at equal context depth: the laptop generates 16 to 33%
  faster than the desktop RTX 3060 (`~/code/ai-lab-posts/posts/speed-oddities.md`, 1,446 and 2,952
  real requests). Largest window that fits 16 GB with KV q4_0: 212,992 tokens, at 12.8 gen tok/s
  when full (`../HANDOFF.md`, "Hardware").
- **Pitfalls.**
  - A dropped link or a sleeping laptop cancels the running item; the rest is re-queued by hand.
  - GPU load plus a large file copy took the laptop to a thermal shutdown (2026-10-12 14:29).
  - The watcher that keeps desktop lanes fed does not cover this lane.

### Desktop with two RX 7900 XTX (since 2026-10-12)

- **Hardware and link.** The same desktop with a second RX 7900 XTX in place of the RTX 3060. Both
  at PCIe 4.0 x8 on CPU lanes, PCI 0b:00.0 and 0e:00.0 (`../HANDOFF.md`, 10-12 14:50).
- **In the model.** Two cards of one model: `RX 7900 XTX #1` (`ROCm0`, `Vulkan0`) and
  `RX 7900 XTX #2` (`ROCm1`, `Vulkan1`), both `orderAssumed`, signature
  `2x RX 7900 XTX 24G | 63G RAM`. `ROCm0` = 0b:00.0 and `ROCm1` = 0e:00.0 were confirmed from
  per-card power logs; the Vulkan pairing is still assumed. Lanes: `local-gpu` (both cards),
  `local-rocm1` (`devices: ["ROCm1"]`), `local-xtx` (`devices: ["ROCm0"]`, paused on purpose: a third
  lane let one-card items starve two-card ones), `local-3060` (its runner stopped, publishing
  nothing: `parked`), `laptop-4090`, `cloud`.
- **Measured.** Qwen3.8-27B UD-Q4_K_XL, 32k prompt: one card 48.8 gen tok/s, both by layer 42.6,
  both by tensor 67.8 (`../sweeps/two-xtx/27b-two-card.result`). In real agent runs the same night,
  tensor split generated 51 to 79% faster than one card at matched depth (`../HANDOFF.md`, 10-12
  21:53). Its answers are close to one card's, not identical
  (`~/code/ai-lab-posts/posts/two-rx-7900-xtx-layer-vs-tensor-split.md`).
- **Pitfalls.**
  - A device probe or a dashboard restart while a two-card engine was decoding stalled it: three of
    three exposures for Strata's pipelined two-card mode, cause not established (same post, "One
    engine death"). This is why probes are now rationed (see "Device probes" above).
  - `-sm row` fails to load (deprecated in llama.cpp); `/api/start` refuses `splitMode: "row"`.
  - Before the topology model the launch guard keyed on the card's name, so a launch on the second
    card was refused while the first was busy.
  - A config written for the old pair still parses: `$D27MTP`-style recipes and `-ot ...=CUDA0` name
    a device that is gone. Such profiles read `unavailable`; a raw command is never rewritten.

### Laptop RTX 4090 + RTX 3060 in the Thunderbolt 4 enclosure (2026-10-12)

- **Hardware and link.** The laptop with the RTX 3060 that left the desktop, in an enclosure:
  `CUDA0` = RTX 4090 (16 GB), `CUDA1` = RTX 3060 (12 GB), CUDA-only build (`../HANDOFF.md`, 10-12
  15:35). The run database's machine record for it shows the enclosure path with one hop at
  2.5 GT/s x1; whether that is the real width or how a tunnelled bridge reports itself was not
  checked.
- **In the model.** On the laptop: two cards, signature `RTX 4090 Laptop 16G + RTX 3060 12G | 31G
  RAM`, the launch `-dev CUDA0,CUDA1 -ts 2,1` reads `RTX 4090 Laptop + RTX 3060, 2:1`. From the
  desktop it ran as the `laptop-4090` lane, whose runtime names one card: the lane widget showed
  `RTX 4090 Laptop` while the item ran on both. Its recorded runs read
  `laptop: RTX 4090 Laptop + RTX 3060 (split 2:1)`; a `-dev CUDA0` run recorded while the RTX 3060 was
  plugged in reads `laptop: RTX 4090 Laptop only`.
- **Measured.** `-ts 5,4` failed at load (the 3060 was 714 MiB short for the MTP draft context);
  `-ts 2,1` loads at 15.3 / 10.3 GB used. Real-run speed for Qwen3.8-27B UD-Q4_K_XL at 128k: 25.6
  gen / 508 prompt tok/s over 398 requests (`../HANDOFF.md`, 10-12 16:03 and 21:53).
- **Pitfalls.**
  - The Thunderbolt link to the card failed after 4 h 29 min under load (kernel `CmpltTO`, `MalfTLP`,
    then `GPU lost from the bus`). The item ended at 10 of 22 tasks.
  - With the dead card still registered, CUDA would not initialise at all, the RTX 4090 alone
    included, until a reboot. One lost card took the whole machine's lane down.
  - A monitor that holds the last reading showed the lost card at 100%.
  - An untested memory split needs a fit test before it is queued, or a fallback item behind it.

### Built or tried, never run

No fixture: there is nothing to describe.

- **RTX 3060 + laptop RTX 4090 as one RPC pool** (2026-10-10). Build, worker, launch wrapper and
  tests exist (`../sweeps/rpc-pool/README.md`: "Nothing here has run on a GPU yet"). Its smoke test
  waited 2.5 h and wrote no result, and the RTX 3060 then moved to the laptop. No model was ever
  loaded on it.
- **OCuLink** (M.2 adapter to an external dock) never linked, in either M.2 slot or on the laptop
  (`../HANDOFF-archive-2026-10-06.md`).
- **Three devices over the wired link** (XTX + 3060 + the worker): the batch was parked, "3-card
  numbers: still not measured" (`docs/archive/BENCH-FINDINGS-DESKTOP-2026-09.md`). The Wi-Fi
  three-device row above is the only one.
- **Flash-Next with whole expert blocks on the worker**: lines written
  (`../resume-2026-09-26/rpc-sweep4.lines`), deferred, never run.

## Still machine-specific

Honest list of what has to change, or be configured, before this runs
unmodified on another machine. Revised 2026-10-13: what that day's change set
removed is listed first, so the rest can be read as what is left.

**No longer tied to one machine (2026-10-13)**

- Config and profile paths: `~`, `${NAME}`, `modelsRoot` (see
  "Configuration"). The example config names no card, id or home directory.
- Strata installs are a configured list; a machine without Strata has none.
- The queue's recipe matchers, the lane for a one-card profile, and the
  Auto queue script's `$STOCK` / `$D27MTP` no longer contain a device id, a
  card name or a binary path (`lib/recipes.js`; the script reads the queue's
  own variables file).
- `RELIABILITY_NOTES` are configuration; the code holds none.
- `lib/strata.js`, `lib/autoqueue.js`, `lib/queue.js` derive the logs, models
  and dashboard directories from where the code is, and the codebench checkout
  from `CODEBENCH_ROOT` or `~/code/codebench`. (Their queue-script directory
  is still one user's: see below.)
- A bare id for a second identical card has a defined fallback.
- The public site's built-in home text states the current hardware (it is
  text, not derived: see below).

**Configuration that is this machine's**

- `dashboard.config.json` on the machine this was written on still uses
  absolute paths (they keep working); `rpcWorkers` (ssh aliases, the worker's
  own binary and log paths) and `remoteAccess` are per-site by nature.
- Build ids (`"all"`, `"vulkan"`) are per-machine names; an unknown id falls
  back to the first build.
- Its saved profiles (`logs/profiles.json`) hold absolute paths and many carry
  a `rawCommand` with the binary and model paths spelled out. They are left as
  they are; `tools/migrate-profile-paths.js` shows their portable form.
- `deviceNames`, `machineNames`, `reliabilityNotes`, `queue.laneByCard` and
  `strataInstalls` there are that machine's history and hardware.

**Paths and names still in code**

- `lib/autoqueue.js` `DEFAULT_MODELS`: the Auto queue's contender list is one
  lab's models -- their file paths (`/data/models/...`, a Hugging Face
  snapshot id), opencode model ids and `$STOCK ... $D27MTP` launch lines. On
  another machine every entry reads "weights missing" until the list is
  replaced in `logs/autoqueue.json`.
- `lib/queue.js` `QDIR` and `lib/autoqueue.js` `DEFAULT_QUEUE_DIR`: a job
  directory under one user's `~/.claude/` (where the generated queue scripts
  and `flash-tuned.env` live). The launch-variable files default to
  codebench's `tools/queue-vars.env` and a file in that directory
  (`queue.envFiles` overrides the files; the script directory is
  `logs/autoqueue.json` `queue.dir`); a profile's opencode model id and database
  pattern are guessed from model-name fragments (`27b`, `flash-next`,
  `iq3_xxs`) that are this lab's models.
- `server4.js` `modelRoots`: `/data/models` is always scanned (harmless where
  it does not exist).
- `lib/suites.js`, `lib/codebench.js`, `lib/postsrepo.js`, `public/`: defaults
  under `~/code/...` (each has an environment override).
- `bench-tools/depth_sweep.py`: a hardcoded `-dev CUDA0,Vulkan2`.
- The public site's home text is a document (`pages/home.md` in the posts
  repository, edited in the dashboard) with a built-in fallback
  (`public/posts.js` `HOME_DEFAULT`). It states the hardware in words and has
  to be edited when the hardware changes: the public process holds no device
  list and never probes.
- Comments throughout name the cards of the day; they are history, not logic.

**Assumptions**

- Linux: `/proc`, `/sys/class/hwmon`, `/sys/bus/pci`, `ss`, `flock`.
- GPU telemetry exists for AMD (`amdgpu_top` + hwmon) and NVIDIA
  (`nvidia-smi`) only. Any other card is launchable but has no readings.
  Fan RPM and memory temperature are AMD-only; NVIDIA reports fan percent.
- Identical cards: backend-to-backend and telemetry-to-card pairing by order
  (see `orderAssumed`).
- An integrated GPU that a backend lists is a card to the model (it starts
  unticked in the launcher).
- A remote lane publishes one `gpu`: a two-card item on another machine's
  lane is labelled with one card.
- An engine with its own launcher takes the cards its `--gpu` list names by
  position in the topology, else the first card. That matches the launch
  guard; it is a convention, not something read from the engine.
- Queue lanes: the `local-` prefix means "this machine".
- "Busy" for the probe rule is a threshold on telemetry (3 GB / 30%), not a
  fact read from the engines.
- Ports (`3000`, `8080`, `8081`, lane tap ports) are fixed defaults.
