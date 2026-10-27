# Plan: heterogeneous N-device layout

Status (2026-09-13): approved, **incremental** (legacy projection kept).
**First draft complete (phases 0-4)**; phase 5 (live rig tests) next, waiting
on te-waza/KataGo coordination. Tests: server 27/27, dash-cli 94/94.
**Phase 0 done**: `build-all` (CUDA + ROCm + Vulkan + RPC, `GGML_BACKEND_DL`)
is the default build, listing `CUDA0`/`Vulkan0` (3060) and `ROCm0`/`Vulkan1`
(XTX); the single-backend builds are superseded (deletion pending the user's
OK). Known follow-ups: saved profiles `27b-rpc` and `daily-27b` store bare ids
(`Vulkan0` is now the 3060, `Vulkan2` no longer exists) and need re-saving from
the device table; neither client can edit multi-device workers
(`workerDevice`); the CLI has no per-request `deviceStats` view. **Phase 1
drafted**: `lib/devices.js` + `test/devices.test.js`, server4.js wired.
**Phase 2 drafted**: monitor.py `hosts{}`/`gpus[]`, `lib/telemetry.js` (+tests)
mapping and legacy projection, per-device samples, `devices_json` CSV column.
**Phase 3 drafted** (web): device table (per-card backend picker, worker rows
with status/start/stop/logs, shares, reorder, Suggest split, draft device),
`devices`-only config I/O with server-side conversion of old configs, N-GPU
sidebar/charts/omni graphs, per-device History/Monitor detail, bench triples;
server `specDraftDevice` + `/api/logs/recent` `deviceStats`. **Phase 4 drafted**
(CLI): hw group is the device list (per-card backend cycle, worker rows with
{worker} status/start/stop/logs, shares, reorder, suggest split, draft
device), `devices`-only config I/O with preview-based conversion + warnings,
N-panel Monitor (per-device buffers, per-host SYSTEM rows), profile device
summaries. Live rig tests
(phase 5) only after the whole first draft. Replaces the "GPU A + GPU B *or*
GPU A + one RPC worker" model everywhere.

## The hardware now

| Device | Where | VRAM | Bandwidth | llama.cpp ids |
|---|---|---|---|---|
| RTX 3060 | desktop, PCIe 09:00.0 | 12 GB | ~360 GB/s | `CUDA0` and `Vulkan0` (same card, listed twice in the CUDA+Vulkan build) |
| RX 7900 XTX | desktop, PCIe 0c:00.0 | 24 GB | ~960 GB/s | `Vulkan1` (**was `Vulkan0`** — saved profiles now point at the wrong card) |
| RTX 4090 Laptop | `laptop`, 192.168.1.125, ~1.3 ms | 16 GB | ~576 GB/s | `RPC0` via ggml-rpc-server (`-d CUDA0` or `Vulkan1` on the laptop) |

Facts that shape the design:

- **llama.cpp is not the limit.** `-dev`, `-ts` and `--rpc` all take N values;
  up to 16 backends. Every 2-device ceiling is in the dashboard — in every layer
  (launch config, command builder, monitor.py, CSV, web UI, dash-cli, docs).
- **The same GPU can appear twice** (`CUDA0` = `Vulkan0` = 3060). The backends
  know each device's PCI bus id, but `--list-devices` doesn't print it, so the
  UI dedupes by normalized name and shows one row per physical card with a
  backend picker. Known limitation: two *identical* cards can't be told apart
  that way (document it; not worth patching llama.cpp now).
- **`build-cuda-vulkan` still has `GGML_RPC=OFF`.** The natural 3-device
  launch — `CUDA0` (3060) + `Vulkan1` (XTX) + `RPC0` (4090) — needs that build
  reconfigured with RPC on. CUDA beat Vulkan on the NVIDIA card for the hybrid
  27B in the August bench, so CUDA is the default backend for NVIDIA cards.
- **27B Q6 + 262k q8_0 KV (~36 GB) now fits locally** on XTX + 3060 (36 GB).
  RPC is no longer required for the daily model; whether XTX+3060 (PCIe, slow
  card) beats XTX+4090 (fast card, network) or all three is an open
  measurement, not an assumption. Phase 5 answers it.
- **KataGo (te-waza) runs on all three GPUs** — the 3060 now hosts its local
  CUDA engine. Clean numbers need te-waza stopped (user has OK'd stop/restart).

## Core decision: one ordered device list

```js
launchConfig.devices = [
  { id: 'Vulkan1', share: 50 },                     // XTX
  { id: 'RPC0',    share: 30, worker: 'laptop' },   // 4090 over RPC
  { id: 'CUDA0',   share: 20 },                     // 3060
]
```

- **Order = `-dev` order = `-ts` order.** The resolver emits `--rpc <endpoints>`
  (one per distinct worker, before `-dev`), then `-dev a,b,c -ts s,s,s`.
  Order matters for layer split (layers go to devices in order; the output
  layer lands on the last), so the UI lets you reorder.
- **Shares are proportions** (llama normalizes `-ts`); the UI shows them as %.
- A single enabled device emits no `-dev/-ts` split flags beyond `-dev <id>`.
- **Legacy fields** `deviceA/deviceB/tensorSplit/rpcTarget` are converted on
  read (server `normalizeProfileConfig`, web config restore, dash-cli
  `configToDraft`) and never written again:
  `A` → share `tensorSplit`, `B` or `RPC0@rpcTarget` → share `100 - tensorSplit`.
- **Workers become a map**: `dashboard.config.json` `rpcWorkers: { laptop: {
  ssh, port, localPort, binary, devices, cache, link } }`. One entry today, but
  each worker needs its own local forward port in ssh-link mode, so the shape
  is right now. Old `rpcWorker` loads as `rpcWorkers.laptop`. RPC device ids
  are assigned in `--rpc` order (`RPC0`, `RPC1`, …), which the resolver
  computes — the UI never hand-types them.
- **Device-id drift guard**: profiles also store each device's *name*
  (`{ id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share }`). On load, ids are
  re-resolved by name against `/api/devices`, so a card being added/removed
  (exactly what just happened) doesn't silently shift a profile onto the wrong
  GPU. Mismatch → warning in the UI, not a silent launch.

## Telemetry model

monitor.py returns a list instead of master/worker slots:

```json
{ "hosts": { "local": {"cpu_name","cpu_util","cpu_temp","ram_used","ram_total","net_bytes"},
             "laptop": { ...same } },
  "gpus": [ {"host":"local","pci":"09:00.0","vendor":"nvidia","name":"NVIDIA GeForce RTX 3060",
             "util","pwr","temp","vram_used","vram_total","process_vram","throttle_reasons":[]},
            {"host":"local","pci":"0c:00.0","vendor":"amd", ...},
            {"host":"laptop","vendor":"nvidia", ...} ] }
```

- Parse **every** nvidia-smi line (today: line 0 only) with `pci.bus_id` in the
  query; **every** amdgpu_top device; hwmon power/temp matched by PCI (today:
  first amdgpu hwmon). Request body: `{ workers: ["laptop"] }`. Removes
  `local_second_gpu` and the `master_is_amd` fallback.
- Per-process VRAM filtered per GPU (today summed across all NVIDIA apps).
- Server maps each launch device → telemetry GPU: local ids by name (backend
  description ↔ nvidia-smi/amdgpu_top name), `RPC<n>` by its worker host.
- **Compatibility projection (key to doing this incrementally):** server4.js
  derives the legacy `stats.master` / `stats.worker` from `gpus[]` (first two
  launch devices, or the two biggest cards when idle). CSV columns, History,
  per-request samples and the existing charts keep working unchanged while the
  new UI moves to `gpus[]`. The projection is deleted once nothing reads it.

## CSV / history

- Don't touch the 42 fixed columns (readers use fixed indexes, three schema
  generations). **Append one `devices_json` column** — per-device
  `{id, name, host, share, util, pwr, temp, vram}` per request.
  `migrateCsvHeader` already supports append-only.
- `RPC` = `yes` when any device is an RPC worker; `Transport` unchanged.
- Old rows: History renders master→device 0, worker→device 1.

## UI

**Web launch panel:** replace GPU A/B selects + RPC toggle + single slider with
a **device table**:

| ☑ | Device | Backend | Share | Free VRAM | |
|---|---|---|---|---|---|
| ☑ | RX 7900 XTX (local) | Vulkan1 | ▬▬▬▬▬ 50% | 24.4 GB | ↑↓ |
| ☑ | RTX 4090 Laptop (laptop) | RPC · CUDA0 | ▬▬▬ 30% | 15.9 GB · ● running | ↑↓ |
| ☐ | RTX 3060 (local) | CUDA0 ▾ / Vulkan0 | ▬▬ 20% | 10.8 GB | ↑↓ |

- One row per physical card; backend dropdown only where a card has both.
- Worker rows come from `rpcWorkers`, with status badge + start/stop/logs
  (boot still auto-starts them). "Suggest split" button: shares proportional to
  free VRAM, with the model+KV estimate shown against the total.
- `--spec-draft-device` picker limited to enabled local devices (default: the
  fastest one), so MTP drafting never round-trips the network.

**Sidebar / Monitor / charts:** N series with a per-device palette and names
(`XTX`, `3060`, `4090@laptop`) instead of yellow=master/red=worker; per-host
CPU/RAM rows. Remove the `/amd|radeon/` panel-swap heuristic. Omni graphs read
`gpus[]` from samples (new samples store the list; old ones use master/worker).

**Bench tab:** already passes free-string `-dev/-ts`; only the device picker
needs N-combinations (solo, pairs, triple) and the auto-matrix's hardcoded
`deviceB: 'Vulkan2'` goes away.

**dash-cli:** same `devices[]` in `launchconfig.js`; the hw group becomes a
device list editor (space toggles, `+/-` share, `[`/`]` reorder); Monitor draws
one GpuBox per GPU (wrapping to rows on narrow terminals), per-host SYSTEM
rows; buffers keyed by GPU. Tests updated from 2-panel to N-panel.

## Phases

0. **Prerequisites.** Reconfigure `build-cuda-vulkan` with `-DGGML_RPC=ON`
   (incremental; no builds while te-waza is using 7 GB of RAM — last session's
   concurrent builds got the dashboard OOM-killed). Update memory
   `rig-hardware.md`.
1. **Backend model.** `devices[]` + `rpcWorkers` map; resolver (`--rpc` list,
   `-dev`, `-ts`, RPC id assignment); raw-command sync parses `-dev/-ts/--rpc`
   lists back into `devices[]`; legacy converter + name-based id re-resolve;
   `/api/devices` returns physical cards (deduped, with backends) plus worker
   devices; ensureRpcWorker for every worker in the list. Unit tests for the
   resolver and converter (there are none server-side today — add a small
   `node --test` file).
2. **Telemetry.** monitor.py `gpus[]/hosts{}`; server mapping + legacy
   projection; `devices_json` CSV column; per-request samples store `gpus`.
3. **Web UI.** Device table, worker rows, suggest-split, N-series charts and
   sidebar, History/Monitor per-device detail, bench picker; migrate
   `last_launch_config` and bench localStorage entries through the converter.
4. **dash-cli.** Mirror of 1–3 plus tests.
5. **Verify on the real rig** (te-waza stopped, restarted after):
   - 27B Q6 across all three: `load_tensors: <dev> model buffer size` for each
     device in the log, all three GPUs moving in telemetry, chat + a ~10k-token
     prompt, CSV row with `devices_json`.
   - **Spill proof:** 27B Q6 @ 262k does not fit the XTX alone (fit check
     refuses) but loads split — the unfinished check from last session.
   - RPC cache: second load of the same split is fast with near-zero transfer.
   - Head-to-head, same prompt set: XTX+3060 (local) vs XTX+4090 (RPC) vs all
     three; Vulkan vs CUDA backend for the 3060 and for the laptop worker.
   - Then turn the winner into profiles (`27b-local`, `27b-3dev`), re-save
     `27b-rpc` in the new shape.
   - Browser pass (device table, charts) and CLI pass.

## Out of scope (say so, don't half-build)

- Different models on different GPUs at once (multiple llama-server
  instances) — separate feature.
- Multiple RPC workers in the **UI** (the data model supports it).
- `--split-mode row` / tensor parallel across mismatched cards (poor fit for
  PCIe + network; layer split only).
- ROCm build for the XTX — blocked on the HIP SDK CMake package (sudo).
- Remote/café RPC — parked after last session's latency analysis.

## Decision needed

**Incremental with the legacy projection (recommended)** — each phase ships
and the dashboard keeps working in between — vs. a clean break (rip out
master/worker everywhere in one pass: less transitional code, but nothing works
until phases 1–4 all land).
