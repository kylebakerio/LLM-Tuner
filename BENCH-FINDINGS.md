# Multi-GPU llama.cpp Benchmark Findings — RTX 4090 Laptop + RX 7900 XTX

Running log of measured conclusions from systematic benchmarking, 2026-08-17/18.
Kept current as tests complete; drafted for eventual write-up/Reddit post.

## Rig

- **GPU A**: RTX 4090 Laptop, 16GB, ~576 GB/s, internal, 80W firmware power cap (Dynamic Boost caps ~95W on Linux)
- **GPU B**: RX 7900 XTX, 24GB, ~960 GB/s, desktop card in a **Thunderbolt 4 eGPU enclosure** (RADV)
- llama.cpp commit `6c8dcaa7a` (2026-08-03), two builds: Vulkan-only and CUDA+Vulkan
- Primary model: Qwen3.8-27B (qwen35 arch: **hybrid SSM + attention, only 16 of 65 layers have KV attention**, head_dim 256, +1 MTP nextn layer), UD-Q6_K_XL (24.13 GiB)
- Probe model for solo-card tests: qwen2.5-coder-7b Q4_K_M (4.36 GiB, dense attention)
- Standard test: `-fa 1 -ctk q8_0 -ctv q8_0 -p 8192 -n 128 -d 0,32768,98304`

## 1. CUDA vs Vulkan on the same NVIDIA card (7B solo)

| test | Vulkan1 | CUDA0 | delta |
|---|---|---|---|
| pp8192 @ d0 | 2180 | 3541 | **+62%** |
| pp8192 @ d32k | 754 | 1437 | **+91%** |
| pp8192 @ d98k | 335 | 556 | **+66%** |
| tg128 @ d0 | 71.1 | 73.6 | +3% |
| tg128 @ d32k | 55.7 | 39.7 | **−29%** |
| tg128 @ d98k | 39.7 | 20.4 | **−49%** |

- CUDA prefill is massively faster (tensor cores + mature kernels). The Vulkan gap exists partly because the driver exposes `VK_NV_cooperative_matrix2` but not all feature bits ggml requires, so Vulkan FA runs the slower KHR_coopmat path.
- **CUDA FA *decode* with q8_0 KV collapses at depth on dense-attention models** (half of Vulkan's speed on the identical card at 98k). This penalty is architecture-dependent — see §2.
- Generation ≈ equal at depth 0: bandwidth-bound, backend barely matters.

## 2. Pairing verdict (27B, ts 40/60): CUDA0/Vulkan2 wins — zero tradeoff

UD-Q6_K_XL, matched ts 40/60:

| test | Vulkan1/Vulkan2 | CUDA0/Vulkan2 | delta |
|---|---|---|---|
| pp8192 @ d0 | 754 | 962 | **+28%** |
| pp8192 @ d32k | 507 | 619 | **+22%** |
| pp8192 @ d98k | 295 | 353 | **+20%** |
| tg128 @ d0 | 18.46 | 18.61 | +1% |
| tg128 @ d32k | 17.07 | 17.00 | 0% |
| tg128 @ d98k | 14.26 | 14.26 | identical |

The 7B's CUDA decode collapse (§1) does **not** transfer: the hybrid arch has only 16/65
attention layers, diluting the quantized-KV FA penalty to nothing. **Verdict is
architecture-dependent**: hybrid-SSM models → CUDA pairing; dense long-context models →
re-test before switching.

Q8_0 quant, ts 40/60 vs 39/61 (~1% skew, verdict unchanged): pp +14/+15/+24%, tg −4/−2/+5%.

## 3. Quant speed: Q6_K's prefill penalty is Vulkan-only

- Vulkan pair: Q6_K_XL prefills **11% slower** than Q8_0 (754 vs 847 @ d0) — K-quant
  super-block dequant is expensive in RADV kernels; Q8_0's flat 8-bit layout is fast.
- CUDA pair: Q6 = Q8 prefill exactly (962 vs 965; 353 vs 355 @ d98k). CUDA dequants Q6_K free.
- Q6 gens ~9% faster than Q8 (fewer bytes/token) with ~3GB more VRAM headroom.
- **With the CUDA pairing, Q6_K_XL strictly dominates Q8_0 on speed.** Q8 remains a
  quality choice, paid in ~3GB context headroom, not speed.

## 4. KV cache quantization costs real speed at depth (even on hybrid arch)

CUDA0/Vulkan2, Q6, f16 KV vs q8_0 KV:

| test | q8_0 KV | f16 KV | delta |
|---|---|---|---|
| pp8192 @ d0 | 962 | 984 | +2% |
| pp8192 @ d32k | 619 | 711 | **+15%** |
| pp8192 @ d98k | 353 | 435 | **+23%** |
| tg128 @ d98k | 14.26 | 15.48 | **+8.6%** |

- Cost: f16 KV ≈ 66KB/token vs q8_0's ≈ 34KB (this arch) → 262k context becomes ~180–200k max.
- **Mixed KV types are a kernel-fallback pit**: `-ctk q8_0 -ctv f16` prefilled at
  **71 t/s** (13× collapse vs 962; gen unaffected at 17.9) — the FA prefill path
  evidently requires uniform KV types and silently falls back otherwise. Mirror
  (`-ctk f16 -ctv q8_0`): also a dud (209 t/s pp2048, ~4× below par). **The KV choice
  is strictly binary: q8_0-both at 262k vs f16-both at ~190k max.** Production
  confirmation of the f16 win: PENDING (srv-f16kv sweep row).
- Related hard constraint: **quantized KV requires flash attention** — `-fa 0` with q8_0 KV
  fails at context creation. FA is effectively mandatory.

## 5. Batch sizes: bigger is worse on a split pipeline

CUDA0/Vulkan2, Q6, q8_0 KV — pp8192 @ d0 / d32k / d98k:

| config | pp8192 d0 / d32k / d98k | vs default |
|---|---|---|
| ub 512, b 2048 (defaults) | 962 / 619 / 353 | — |
| ub 1024 | 840 / 536 / 304 | −13% everywhere |
| ub 2048 | 664 / 434 / 242 | −31% |
| **ub 256** | 993 / 638 / 372 | +3–5% |
| **b 4096** (ub default) | **1052 / 675 / 381** | **+8–9%** |
| ub 256 + b 4096 | 1026 / 666 / **389** | +7–10% |

Generation is unchanged in every case (~18.6 / 17.0 / 14.1 t/s — batch knobs are
prefill-only levers here).

Single-GPU folklore ("raise ubatch for prefill") inverts on layer-split multi-GPU:
llama.cpp pipelines ubatches across GPUs (GGML_SCHED_MAX_COPIES=4). Bigger chunks =
coarser overlap and larger per-boundary transfers (XTX is on TB4) → ub 1024/2048 lose
badly. Going the other way helps: smaller chunks (ub 256) +3–5%, and a deeper chunk pool
per decode call (**b 4096: +8–9%, the single best free win**) lets the scheduler keep the
pipeline full. The stack (ub 256 + b 4096) only edges ahead at 98k depth (+2%, near
noise).
- **Transfer caveat: the `-b 4096` gain did NOT reproduce in real llama-server prefill**
  (22k cold prompt: 522 vs 532 t/s with the spec stack; 965 vs 973 without — no change).
  llama-bench's pp path and the server's prompt-processing path evidently schedule
  differently. Harmless to keep the flag, but it is not the free +9% in production that
  the bench suggested. Investigate someday.
- **f16 KV server transfer (final, new model revision)**: 565.8 prefill / 25.0 gen vs
  q8_0's 526 / 25.1 on the same 22k prompt — **+7.5% prefill, gen unchanged** (about
  half of what the bench promised at that depth; better transfer than -b's zero).
  Priced against the 3.4:1 gen-dominated workload that's ~+2% net wall time, for the
  cost of 262k → 150k context. **Decision: q8_0 KV at 262k stays. KV chapter closed.**

## 6. Row split (`-sm row`) is unavailable on this rig — by construction

`llama-model.cpp` resolves row split via the backend's `ggml_backend_split_buffer_type`
proc. **The Vulkan backend does not implement it at all** ("device does not support split
buffers"), and CUDA's implementation splits across multiple CUDA devices only (we have
one). Mixed CUDA+Vulkan row split is doubly impossible. Layer split (taking turns) is the
only multi-GPU mode for this hardware; per-token GPU utilization (~45%/65%) matching each
card's layer share confirms the serial pipeline runs with no dead air.

## 7. Speculative decoding stack (llama-server; llama-bench can't measure this)

Real-workload A/B (code-review prompt, 22k cold prefill + 1024 gen tokens, CUDA pairing):

| config | gen t/s | draft acc |
|---|---|---|
| draft-mtp + ngram-map-k4v (defaults: M=48, hits=1), nmax=3 | 25.0 | 40% |
| draft-mtp only | 24.6 | 39% |
| ngram-map-k4v only | **17.1** | 4–14% |
| mtp + k4v, **min-hits=2** | **29.2** | 53% |
| mtp + k4v, M=96 | 25.4 | 36% |
| mtp + k4v, **M=24** | **29.6** | 50% |

- No-spec baseline ≈ 17–18 t/s → the tuned stack is **~+70% generation**.
- **Constraining ngram beats amplifying it** (old build): rejected draft tokens waste
  verify compute; `min-hits=2` and `M=24` (shorter drafts) each ~+17% over defaults.
- **Rebuild caveat (master `6d0549831`)**: re-running the same sweep, defaults improved to
  28.3 t/s (+13% from the rebuild alone) and the tuning deltas compressed into
  run-to-run noise (defaults 28.3, hits=2 25.9, M=24 27.1 — single reps at temp 1).
  The upstream spec refactors appear to have absorbed much of what the constraint
  tuning was buying. Defaults are fine on current master; re-tune only with multi-rep
  runs if chasing the last few percent.
- ngram alone ≈ no-spec on novel content; it shines on regurgitation (one compaction-style
  request hit **100% acceptance → 85.7 t/s**, ~4× the bandwidth ceiling, on a 27B).
- Acceptance % is a diagnostic, not a target — tune on gen t/s.
- **Post-rebuild knob sweep (2026-08-19): nothing beats defaults.** ngram-mod is
  clearly worse (21.0 vs 25.2 gen — adaptive resetting turns conservative: high
  acceptance, few drafts); `--spec-draft-p-min` 0.5 and 0.9 are both a wash vs the
  ~0.75 default. Combined with the tuning deltas evaporating after the rebuild, the
  ngram/MTP search space is exhausted: **run defaults**.
- **Trained-drafter attempt (DSpark head for this target, magnitudedev GGUF
  conversion, arch `dflash`): failed hard** — 1–5% draft acceptance, generation
  collapsed to ~4 t/s (drafting + cross-device overhead with zero accepted tokens),
  prefill ~470. Near-zero acceptance means the head's outputs don't match this
  target (bad conversion, wrong revision, or dflash/dspark pipeline mismatch), not
  an overhead problem.
- Retry with `--spec-type draft-dspark` (overriding the GGUF's dflash tag): runs, and
  acceptance jumps 1–5% → 33% — confirming the pipeline mismatch — but 33% can't pay
  for cross-device drafting overhead: 7.9 t/s. Head judged mediocre for this target;
  dropped after two strikes. **Champion stands: `draft-mtp,ngram-map-k4v`, defaults.**

## 8. MTP's hidden prefill tax (~1.9×) — mechanism located: target-side, not catch-up (2026-08-20)

- Measured: prefill ~520 t/s with draft-mtp enabled vs ~975 without (matches no-spec).
- Mechanism (`common/speculative.cpp`, MTP `process()` hook): unless the model's MTP
  context **shares KV memory with the target** ("e.g. Gemma4"), every prefill ubatch
  triggers a synchronous **catch-up decode in the draft context** — the prompt is
  effectively processed twice, and the extra sync breaks the multi-GPU ubatch pipeline.
  Qwen3.8's MTP context is not mem-shared → full tax.
- Net accounting on 4 days of real usage (139 requests): prefill 1.45h vs generation
  4.94h (**3.4:1 gen-dominated**). Dropping MTP would refund ~40min of prefill but cost
  48–96min of gen. **Keeping MTP wins decisively** despite the tax.
- **Re-measured after rebuilding at master `6d0549831` (2026-08-18): the tax is
  unchanged** — prefill 532/522 t/s with MTP vs 973/965 without (~1.85×).
- **Final isolation matrix (2026-08-19) — the tax is a MULTI-GPU cost, full stop**:
  CUDA solo **1.03×** (766→742), Vulkan solo 1.13× (572→505), A3B Vulkan solo
  1.22×; CUDA+Vulkan split 1.82–1.83× (two quants), **all-Vulkan split 2.00×**
  (754→376). An earlier "1.82× CUDA solo" reading was a mislabeled split run — the
  true solo cell killed the CUDA-graph theory. `graphs reused` halves under MTP
  everywhere but costs little solo; the expensive part is the per-ubatch draft
  decode breaking cross-device ubatch pipelining on layer split. eGPU/TB4
  exonerated. **Pairing verdict unchanged**: MTP'd prefill 532 CUDA pair vs 376
  Vulkan pair (434 Q8-Vulkan), gen equal — CUDA0/Vulkan2 stays. Batch knobs can't
  bridge that gap (≤10% bench, 0% server) — no vk-pair -ub/-b retest warranted.
- Workaround test: `--spec-draft-device CUDA0` on the split lifts MTP'd prefill
  532→573 (+8%, outside the ±3 noise band) but doesn't recover the 2× — the stall is
  the per-ubatch interruption itself, not draft-context placement. **Adopted into the
  daily profile anyway: +8% free.**
- **Acceptance corroborates upstream #26750** (CUDA MTP acceptance collapse): same
  Q3 file solo — 41% acceptance on CUDA vs 64% on Vulkan; explains why Vulkan-solo
  MTP gen (44 t/s) far outruns CUDA-solo (26 t/s) on this rig.
- Isolation bonus: on the A3B, MTP is +61% generation (83.9 vs 52.1 t/s, 66%
  acceptance) — the 35B-A3B solo on the XTX is a legitimately fast light-duty
  config (~84 t/s gen, ~1300-1600 t/s prefill).
- **Local fix attempt (2026-08-19/20), deferred-catchup patch**: rewrote MTP's
  `process()` to accumulate catch-up tokens into `batch` and flush once per
  `n_batch`-sized chunk (or at `begin()`/`draft()`) instead of decoding
  synchronously every prefill ubatch — the exact mechanism named above.
  **Result: no recovery.** 554.5 t/s (Q3, CUDA+Vulkan split, 22k prompt) —
  identical to the unpatched 527–573 band. Draft acceptance/mean-len stayed
  healthy (49.6%, 2.49), so the patch itself worked correctly; it just didn't
  buy anything.
- **Diagnostic (2026-08-20): fully skip the catch-up decode, same harness
  (Qwen3.8-27B Q6_K_XL, snapshot 27af057e, CUDA0+Vulkan2 split, 40/60,
  q8_0 KV, 262k ctx, 22k-token cold prompt) — three-way comparison:**

  | variant | prefill t/s | graphs reused | draft acceptance |
  |---|---|---|---|
  | `ngram-map-k4v` only (no MTP) | 988.7 | 254 | n/a |
  | `draft-mtp,ngram-map-k4v` (control, patch unset) | 557.7 | 112 | 41.3% |
  | `draft-mtp,ngram-map-k4v` + catch-up decode skipped entirely | 606.1 | 246 | 0.8% (expected — stale draft KV, degraded on purpose for this measurement) |

  Skipping the catch-up decode *completely* only recovers **~9% of the gap**
  (557.7 → 606.1, vs a ~988.7 ceiling) — nowhere near closing it. **The
  per-ubatch catch-up decode is not the dominant cost.** Curiously,
  `graphs reused` recovers almost fully (246, close to the no-MTP 254) even
  though prefill throughput doesn't follow — so `graphs reused` is not the
  reliable throughput proxy it looked like in the isolation matrix above; the
  earlier "supporting evidence" reasoning from that counter is weaker than
  stated.
- **Mechanism located (2026-08-20), via per-ubatch instrumentation**: added
  `MTP_TRACE`-gated timestamps around `llama_decode(ctx_tgt, batch_view)` in
  `tools/server/server-context.cpp` and around `llama_get_embeddings_nextn` /
  the catch-up `llama_decode(ctx_dft, ...)` loop in `common/speculative.cpp`
  (committed on the `mtp-diag` branch, see commit `e955b70ff`). Ran the same
  22k-token prompt on the same harness (Q6_K_XL, CUDA0+Vulkan2, 40/60, q8_0
  KV) with `draft-mtp,ngram-map-k4v` and with `ngram-map-k4v` alone, both
  traced. The 12 prefill ubatches are byte-identical in shape between the two
  runs (42, 2048×8, 810, 512 tokens; `has_output=0` on all 12 in *both* runs
  — ruling out the "MTP forces per-position output flags" theory from the
  previous entry, cleanly, since the flag itself never differs):

  | phase | MTP | ngram-only | ratio |
  |---|---|---|---|
  | `tgt_decode` (target's own decode, 12 prefill ubatches) | 33422.6 ms | 18342.6 ms | **1.82x** |
  | `spec_process` (MTP catch-up total) | 2112.2 ms | n/a | — |
  | &nbsp;&nbsp;of which `catchup_decode` | 1982.3 ms | — | — |
  | &nbsp;&nbsp;of which `get_embd_nextn` (reads target's nextn state) | 1.2 ms | — | — |

  **~94% of prefill time is inside the target's own `llama_decode()` call,
  which never touches the draft context at all.** The catch-up decode is a
  real but minor cost (~6%). This closes the loop from both ends: removing
  `spec_process`'s 2.1s from the 35.5s total predicts 19800/33.4s ≈ 593 t/s
  with catch-up skipped — the independent skip-catchup diagnostic (previous
  entry) measured 606 t/s. And the isolated `tgt_decode` ratio (1.82x) lands
  within 2% of the server-level prefill ratio (974.6/548.8 = 1.78x). Two
  independent measurements agree.
  - **Direct evidence the target's graph is structurally different**: the
    ngram-only run's own load log prints `model has unused tensor
    blk.64.nextn.eh_proj.weight -- ignoring` (and 3 sibling nextn tensors) —
    confirming the nextn/MTP-head tensors are loaded but *not wired into the
    forward graph* when MTP isn't the active spec type. With draft-mtp
    active, those tensors ARE wired in (that's what `llama_get_embeddings_nextn`
    reads) — so the two runs' target forward passes are measurably different
    graphs, not just different schedules.
  - **Hypothesis for *why* this costs ~1.8x on a split but only ~1.03–1.22x
    solo (unproven, best fit to all evidence)**: serving the catch-up
    mechanism requires the target to materialize the nextn hidden state for
    every position of every prefill ubatch (not just sampled positions) —
    effectively an all-positions-output workload layered onto every ubatch's
    forward pass. That's a small raw-FLOPs increase (one extra light head)
    but plausibly forces the same kind of per-ubatch pipeline drain that
    embedding-mode workloads hit on a layer split — fitting both the solo/split
    matrix in this section (nothing to drain on one GPU, real cost across two)
    and why `graphs reused` tracks the *catch-up* interleave specifically
    (246≈254 when catch-up is skipped, prefill still slow) rather than this
    larger, separate cost. Confirming this precisely would need either
    disabling the target-side nextn materialization directly (real llama.cpp
    surgery, not attempted) or a GPU-level trace (nsys covers the CUDA0 side;
    no equivalent tool exists for the Vulkan/RADV side on this rig).
  - **Corrections to the previous entry's calls, stated rather than silently
    changed**: "discount `graphs reused` as evidence" was too broad — refined
    above to "it tracks the catch-up interleave, a minor cost, not the major
    one." The "`need_embd`/logits=1 forces per-position output" lead had the
    right shape (all-positions output) but the wrong code path — it's
    `llama_get_embeddings_nextn` (a dedicated MTP accessor), not the batch's
    per-token `output` flag gated by `slot.need_embd()`; this trace's
    `has_output=0` data on all 12 prefill ubatches in both runs kills the
    flag-path version specifically, not the broader idea.
  - File the symptom, the isolation matrix, AND this located-but-not-fully-
    explained mechanism — it's more precise than the original "catch-up
    decode breaks pipelining" claim (now known wrong) without overclaiming a
    fix.
- **Cross-check (2026-08-20): same trace on Vulkan1+Vulkan2 (NVIDIA card via
  Vulkan instead of CUDA, paired with the AMD card, also via Vulkan — same
  backend on both sides, no CUDA anywhere).** Correction to the "all-Vulkan"
  framing used earlier in this doc and in the upstream issue: this is NOT a
  "zero NVIDIA hardware" test — `Vulkan1` is still the 4090's silicon, just
  accessed through the Vulkan driver instead of CUDA. It only rules out the
  *CUDA API/runtime* as the cause, not NVIDIA hardware generally (this rig has
  only one AMD card, so a true zero-NVIDIA-hardware split isn't possible here).
  Same 22k-token harness, identical prefill ubatch shapes in both runs
  (42, 2048×9, 810, 512):

  | metric | draft-mtp | ngram-only | ratio |
  |---|---|---|---|
  | `tgt_decode` prefill total (12 ubatches) | 80961.0 ms | 24065.2 ms | **3.36x** |
  | catch-up (`spec_process`, ~all `catchup_decode`) | 7539.0 ms | n/a | 8.5% of MTP total |
  | server-reported prefill t/s | 214.8 | 775.8 | 3.61x |

  Bigger tax than the CUDA+Vulkan pairing (3.36x vs 1.82x), and catch-up is
  again a minor share (8.5%, consistent with the 6% found on CUDA+Vulkan) —
  same conclusion, reproduced on a same-backend symmetric split, stronger
  effect. (Absolute numbers aren't comparable to the older 754/376 llama-bench
  figures elsewhere in this doc — those used `llama-bench` pp8192, a different
  tool and prompt length; this is the same testreq.json server-harness used
  for the CUDA+Vulkan trace above, apples to apples only within this entry.)
  - **New wrinkle**: the per-ubatch ratio isn't a flat multiplier here — it
    climbs from 1.04x (first, 42-token ubatch) up through ~3.3–3.8x across the
    nine 2048-token ubatches, then spikes to **6.04x** on the 810-token
    ubatch before dropping to 2.11x on the final 512-token one. A clean
    "X% more FLOPs per token" story predicts a roughly flat ratio regardless
    of ubatch position; this staircase-then-spike shape looks more consistent
    with a scheduling/synchronization effect that compounds or varies across
    the run than with pure extra compute — but this is one run, not confirmed
    against a repeat, and not yet explained.
- **nsys/NVTX cross-check on the CUDA0 side (2026-08-20)**: instrumented the
  `mtp-diag` build with NVTX ranges (same functions as the `MTP_TRACE`
  timestamps, committed `e6dcba49d`) and ran both variants (CUDA0+Vulkan2
  pairing, same harness) under `nsys profile`. `nsys stats --report nvtxsum`
  independently reproduced the CPU-side timing split almost exactly (90.4%
  `tgt_decode`, 5.0% `spec_process`, 4.6% `catchup_decode`, ~0% `get_embd_nextn`
  — matches the manual chrono trace within noise), confirming the
  instrumentation itself is trustworthy.

  The useful new angle: `nsys stats --report nvtxgpuproj` projects each NVTX
  range onto the GPU timeline, showing how much of the range's wall-clock
  duration is actually covered by GPU ops issued from CUDA0. For the 12
  prefill `tgt_decode` ranges:

  | | CPU wall-clock total | GPU-attributed span | coverage |
  |---|---|---|---|
  | draft-mtp | 33410.6 ms | 27291.9 ms | 81.7% (18.3% gap) |
  | ngram-only | 18220.2 ms | 16415.6 ms | 90.1% (9.9% gap) |

  Two things are both true and both matter: the **gap** (wall-clock time with
  no GPU op attributed — idle/dispatch overhead) roughly doubles as a
  fraction (9.9% → 18.3%), but the **GPU-attributed span itself is also
  1.66x longer** (16415.6 ms → 27291.9 ms) with MTP active. So this isn't
  simply "CUDA0 sits idle waiting on the other device" — CUDA0 is measurably
  doing more/slower GPU-side work too, on top of a real (smaller) increase in
  idle/dispatch overhead.
  - **Hypothesis (still unproven) connecting this back to `graphs reused`**:
    a collapsed CUDA-graph-capture/replay rate (112 vs 254, from the original
    isolation matrix) would produce exactly this signature — fewer captured
    graphs means more individual kernel launches instead of one cheap replay,
    which inflates both the GPU-attributed span (kernels dispatched more
    serially, each paying its own overhead) and the CPU-side gap (more
    launch/sync round-trips). This would reconcile the graphs-reused counter
    as relevant again, but through a different channel than originally
    theorized (kernel-launch overhead from lost graph capture, not cross-
    context synchronization from the catch-up decode specifically). Not
    confirmed — would need a kernel-launch-count comparison between the two
    runs to test directly, not yet done.
  - This cross-check used `nsys`, which needed no elevated privileges on this
    machine. There is no equivalent tool available for the Vulkan/RADV
    (AMD) side without either a ROCm/HIP install (a different backend than
    the one actually measured) or reading the kernel's own AMDGPU scheduler
    tracepoints via `perf`, which needs root once. See `amd-trace.sh`.
- **AMD-side (RADV) trace via `perf` + kernel `amdgpu`/`gpu_scheduler`
  tracepoints (2026-08-20) — the starkest signal yet.** `amd-trace.sh mtp`
  and `amd-trace.sh ngram` (both committed) capture `drm_sched_job_run` /
  `drm_sched_job_done` events system-wide during the same repro. Located each
  run's prefill window from event density, then measured the AMD GPU
  scheduler's own idle time: gaps between a job finishing (`_done`) and the
  next job starting (`_run`) anywhere on the device.

  | | prefill window | idle gap (`_done`→`_run`) | largest single gaps |
  |---|---|---|---|
  | draft-mtp | 36.8s | **46.1%** | 971 ms, 1004 ms (two near-1s stalls) |
  | ngram-only | 19.9s | 10.2% | 991 ms (one outlier; next-largest only 393 ms) |

  **The AMD GPU sits idle 4.5x more (as a fraction of prefill time) when MTP
  is active** — this is the largest, most direct effect found across all
  three instrumentation angles (CPU-side chrono, CUDA0 nsys, AMD ftrace).
  Nearly half of MTP's prefill wall-clock time on this pairing is the AMD
  card doing *nothing at all*.
  - Both runs show a nonzero idle baseline (~10%) even without MTP — some
    pipeline-bubble idle time is presumably a normal cost of any two-device
    layer split, MTP or not. What MTP adds is the extra ~36 points.
  - **Partial explanation, not the whole story**: `--spec-draft-device CUDA0`
    pins the catch-up decode entirely to the NVIDIA card — while it runs
    (measured at 1982 ms total across the 12 prefill ubatches on the CUDA0
    trace), the AMD card has structurally nothing to do, since catch-up never
    touches it. But that alone predicts only ~6% additional AMD idle time
    (1982 ms / ~33.4s), not the ~36-point jump actually measured — so most of
    the extra AMD idle time is NOT simply "waiting out the catch-up decode."
    It's consistent with the CUDA0-side finding above (CUDA0 itself takes
    1.66x longer to finish its portion, which would push AMD's next input
    later too, extending its idle wait beyond the catch-up window alone) —
    the two sides' data agree with and reinforce each other rather than
    telling separate stories.
  - Net picture from all three instrumentation angles together: MTP being
    active makes CUDA0's own work take measurably longer AND makes the AMD
    card sit idle for a much larger share of the prefill — both effects real,
    both pointing at degraded cross-device pipelining as the mechanism,
    neither one alone fully explaining the ~1.8-3.4x tax. Still short of a
    root cause inside llama.cpp's scheduler/graph-capture code, but this is
    about as far as black-box tracing (vs. reading/modifying the scheduler
    source directly) can take it.

## 9. Tensor split sensitivity: low

45/55 vs 40/60 (CUDA pair, Q6): prefill +5–7% (more layers on the prefill-fast CUDA card),
gen −1.5–2% (more bytes on the slower-bandwidth card). Weighted by the 3.4:1 gen-dominated
workload it's a wash; 40/60 also preserves VRAM headroom on the 16GB card. Splits within
±5 points of VRAM-proportional are all fine.

## 10. Miscellaneous measured facts

- TB4 to the eGPU is negligible for solo and layer-split use (weights/KV/activations stay
  on-card; per-token boundary traffic is KBs).
- Bandwidth efficiency: XTX solo gen achieves ~41% of its 960 GB/s; the 4090 ~54% of its
  576 GB/s. The XTX has the pipes, RADV wastes more of them; the smaller card runs cleaner.
- The 4090's 80W cap only became binding once CUDA kernels could saturate it (Vulkan-era
  ~50W draw was kernel starvation, not power headroom).
- llama-bench gotchas: device pairs use `/` (`CUDA0/Vulkan2`); a comma benches each device
  separately. Repeated flags (e.g. two `-fa`) build a test matrix, not an override.
- llama-server's `-fit` pre-check estimates against free VRAM + margins (default 1GiB/dev
  + the spec/MTP context reservation) and refuses launches that would actually fit;
  `-fitt 256` reclaimed 262k context that the default margin refused.

## Open items

- [x] `-ub 256` / `-b 4096` / stacked — measured in llama-bench; server transfer FAILED (§5)
- [ ] Mixed KV: `-ctk q8_0 -ctv f16` vs `-ctk f16 -ctv q8_0`
- [x] Spec knob sweep post-rebuild — defaults win everywhere (§7)
- [x] DSpark head — dspark mode confirmed correct pipeline (33% acc) but still 3× slower
      than champion; dropped (§7)
- [x] Rebuilt at `6d0549831` — MTP tax unchanged (§8); spec gen +13%, tuning deltas now noise (§7)
- [ ] File upstream issue: MTP catch-up decode ~2× prefill cost on non-mem-shared archs
- [x] f16-KV server confirmation — +7.5% prefill only; q8_0@262k final (§4/§5)
