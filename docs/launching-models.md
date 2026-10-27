# Launching models

This page covers:

- how LL-Dash builds and runs a launch;
- how saved profiles move between machines;
- builds, RPC workers and the Strata engine.

[TOPOLOGY.md](../TOPOLOGY.md) has the full hardware model.
[API.md](../API.md) ("Launch control") has the request and response formats.

## Devices: an ordered list

The master `llama-server` always runs natively on this machine. A launch runs on
an **ordered list of devices**, which can be any mix of local GPUs and RPC
workers.

The order of the list is used three ways:

- it is the `-dev` order;
- it is the `-ts` order;
- a layer split hands out layers in that order.

For example:

```
--rpc 127.0.0.1:50052 --split-mode layer -dev Vulkan1,RPC0,CUDA0 -ts 50,30,20
```

**The device table** has one row per physical GPU (detected for each build),
plus one row per configured RPC worker.

- **Choosing devices.** Tick the rows to use. Their order from top to bottom is
  the layer order, and ↑/↓ reorders them.
- **Shares.** Each row's share is its `-ts` proportion.
  - Leave the shares blank to let `llama-server` split by free VRAM.
  - Or click **Suggest split** to fill them in proportion to free VRAM.
- **Backends.** A card reachable through two backends gets a backend picker.
  For example, an NVIDIA card in a CUDA+Vulkan build is both `CUDA0` and
  `Vulkan0`. The vendor backend is preferred, then Vulkan.
- **Identical cards** are numbered `#1`, `#2`. They are paired across backends
  by listing order.
- **Worker rows** show a status badge and Start / Stop / Logs buttons. Loading
  a model starts any workers it needs.
- **Split mode.**
  - `layer` is the default.
  - `tensor` is experimental in llama.cpp.
  - `row` is refused because it fails to load.

**Saved devices carry the card's name as well as its id.** Ids shift when a GPU
is added or removed. When a saved id now points at a different card, the server
moves the device to the right card, and shows a warning under the table and the
command.

**The raw command box is the source of truth.**

- The form seeds the box, through the preview endpoint, on every change.
- Whatever text is in the box at launch time is what runs.
- `-m`, `--port`, `-dev`, `-ts` and `--rpc` in the box are synced back into the
  server's launch config. The request log, the `/slots` poll and telemetry
  therefore all use the values that actually ran.
- Launches are validated before they start. The checks are:
  - the model path exists;
  - ctx and ngl are finite numbers;
  - the port is between 1 and 65535;
  - the build and the workers are known;
  - no device is listed twice.

The command runs exactly as given. Read the
[security notes](../README.md#default-exposure) before you expose port 3000.

## Launch guards

`POST /api/start` refuses two kinds of launch with `409`. In both cases nothing
is started.

- **`UNAVAILABLE_HERE`:** the launch needs hardware this machine doesn't have,
  such as a card it lacks, more cards, or more memory.
  - To launch anyway, repeat the request with `allowUnavailable: true`.
  - The web UI and the CLI ask you first.
- **`CARD_BUSY`:** a running queue item is using a card the launch needs.
  - To launch anyway, repeat the request with `force: true`.

## Profiles and other machines

Saved profiles live on the server, in `../logs/profiles.json`. The web UI and
the CLI both use them. On each machine, every profile is rated by how well it
fits:

| Status | Meaning |
|---|---|
| `ready` | Runs as saved. |
| `moved` | Same cards, different ids on this machine. Re-pointed and launched. |
| `substitute` | A card this machine lacks is replaced by one at least as large. Not validated. |
| `unavailable` | Needs hardware this machine doesn't have. The UI asks before loading it. |

A profile moves best between machines when it does two things:

- uses portable paths (`~/…`, `${NAME}/…`);
- keeps device ids out of its extra arguments.

`tools/migrate-profile-paths.js` shows the portable spelling of an existing
store. It writes the result only when you pass `--write <new-file>`.

## Device probes

`llama-server --list-devices` initializes every backend on every card, which
can stall a model that is generating. The dashboard therefore probes a build's
devices only in two cases:

- **When nothing is running on a local GPU.**
- **When you ask for it:** `?refresh=1`, or the launcher's "probe now" link. The
  launcher asks first if the cards look busy.

Further rules:

- A probe never runs while queued runs are using the cards.
- Device lists are cached in `logs/device-cache.json` inside the checkout.
- A probe that fails never replaces a good earlier list.
- The same rules apply to reading a build's `--help` for the flag reference.

## Builds

Any llama.cpp build works; list each one in `llamaServerBuilds`.

A single binary can also hold every backend:

- CUDA for NVIDIA cards;
- ROCm for AMD cards;
- Vulkan for both;
- RPC.

Each backend is then loaded at runtime (`GGML_BACKEND_DL`), which is the only
way CUDA and ROCm can share one binary. Such a build lists each card under two
ids (for example `CUDA0` and `Vulkan0`), so the backend can be chosen per card.

Here is an example. Substitute your own toolkit paths and GPU architectures:

```bash
# in a llama.cpp checkout; ROCM_PATH and CUDA_HOME point at your toolkits
HIPCXX="$($ROCM_PATH/bin/hipconfig -l)/clang" HIP_PATH=$ROCM_PATH \
cmake -S . -B build-all -DCMAKE_BUILD_TYPE=Release \
  -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=ON -DGGML_RPC=ON \
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=<cuda-arch> -DCUDAToolkit_ROOT=$CUDA_HOME \
  -DGGML_HIP=ON -DGPU_TARGETS=<gfx-target> -DCMAKE_PREFIX_PATH=$ROCM_PATH \
  -DGGML_VULKAN=ON
cmake --build build-all --config Release -j --target llama-server llama-bench ggml-rpc-server
```

Notes on this build:

- Builds with runtime-loaded backends reject `GGML_NATIVE`, so the CPU backend
  is built in several variants and the best one loads at runtime.
- If ROCm's clang cannot find the C++ standard headers, point it at an installed
  GCC with `-DCMAKE_HIP_FLAGS=--gcc-install-dir=<path-to-gcc>`.
- If an old `glslc` is first on your PATH, pass a newer one with
  `-DVulkan_GLSLC_EXECUTABLE=<path>`.

## RPC workers

A worker is another machine running a plain `ggml-rpc-server`. No Docker is
involved. Each worker is an entry in `rpcWorkers`:

| Field | Default | Meaning |
|---|---|---|
| `ssh` | the entry's name | SSH target: `user@host`, or an `~/.ssh/config` alias. It must work non-interactively (`BatchMode=yes`). |
| `port` | `50052` | The port `ggml-rpc-server` listens on, on the worker. |
| `link` | `"ssh"` | `"ssh"`: the worker listens on its own loopback only, and RPC goes through an `ssh -L` forward that the dashboard manages. `"direct"`: the worker listens on all interfaces and the master connects to it directly. Use `direct` on a trusted LAN only. |
| `localPort` | `50052` | This machine's end of the SSH forward. Give each worker its own. |
| `binary` | `~/llama-rpc/ggml-rpc-server` | The path on the worker. |
| `devices` | all | The worker's `-d` device list. **Set it explicitly**: by default `ggml-rpc-server` serves every non-CPU device, including integrated GPUs. |
| `logFile` | `~/llama-rpc/rpc-server.log` | The path on the worker. |
| `cache` | `true` | Passes `-c`. The worker caches large tensors locally, so later loads of the same model send only hashes. |

**Starting and stopping workers.**

- Loading a model starts every worker the launch needs, and opens its forward.
- To do it by hand, use any of these:
  - the worker row's Start / Stop / Logs buttons;
  - `/api/worker/*`;
  - `w` in the CLI's config editor.
- Over SSH, these run `setsid nohup <binary> …`, `pkill -x`, `pgrep -x` and
  `tail` on the worker.

**Build every worker from the same llama.cpp commit as the master.** Both sides
must speak the same RPC protocol.

**Building a worker binary.** If the worker has no toolchain, build a portable
binary on the master and copy it over:

```bash
cmake -B build-rpc-worker -DGGML_VULKAN=ON -DGGML_RPC=ON -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build-rpc-worker -j --target ggml-rpc-server
scp build-rpc-worker/bin/ggml-rpc-server <worker>:llama-rpc/
```

- ggml is linked statically.
- The binary still needs the system's `libstdc++`, `libgomp` and the Vulkan
  loader, plus the GPU driver.
- A CUDA worker also needs `libcudart`, `libcublas` and `libcublasLt` on its
  library path.

**RPC device ids.**

- ggml-rpc names worker devices `RPC<n>`, numbered across all `--rpc` servers in
  order. A worker serving two devices takes two numbers.
- `--rpc` must come before `-dev`.
- The dashboard assigns these ids itself, so you never type them.

## Strata engine (optional)

Strata is an external inference engine, not part of llama.cpp.

If `strataInstalls` (or `STRATA_DIR`) lists one or more installs, choosing
**Engine = Strata** replaces the llama.cpp settings with the **Strata config**
group. That group has:

- **A base config:** one of each install's `strata-*.json` files, grouped by
  install, with the current install first.
- **Overrides:**
  - max context, KV type (`int8`, `fp16`, `q4_0`, `k8v4`) and KV resident;
  - speculative n and min-p;
  - RoPE;
  - pipeline windows and resident budget;
  - GPUs and layer split;
  - two engine switches;
  - sampling.

How the overrides behave:

- A blank override keeps the file's value, which is shown as the placeholder.
- The overrides are merged into a copy under `../logs/strata-dashboard/`.
- That copy is launched through the base config's own install's
  `queue-serve.sh`.
- An override that the install's engine does not support is refused before
  anything starts.
- The CLI has the same fields.

[API.md](../API.md) ("Strata overrides") has the full table. Strata servers
default to port 8095.
