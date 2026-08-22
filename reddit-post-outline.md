# Reddit post draft — r/LocalLLaMA

**Framing decision: the tuning journey, anchored by the knob table.** Not an eGPU post
(niche hook, and the eGPU turned out NOT to matter — that's a punchline, not a premise),
not a dry report. The story is "15 → 26+ t/s and 60k more context on the same hardware,
every knob measured, here's exactly what paid and what didn't." The two tables below are
the post; everything else is supporting material.

**Working title:** "I spent 4 days benchmarking every llama.cpp knob on my 4090
Laptop + 7900 XTX rig: +70% generation, 2.3x prefill, 60k more context — and half of
what I believed going in was wrong (including two of my own published conclusions)"

---

## TL;DR (open the post with this)

Same hardware, before → after: **generation 15–18 → 26–28 t/s, cold prefill ~376 →
~570 t/s (22k prompt), usable context 200k → 262k.** Model: Qwen3.8-27B UD-Q6_K_XL
split across an RTX 4090 Laptop (16GB, CUDA) and a 7900 XTX (24GB, Vulkan/RADV, TB4
enclosure). Final command at the bottom.

**The single biggest win was the last thing I found, and it was a default I had never
questioned: `--spec-draft-n-max 3` → `2` is worth 2.3x prefill on this model.**
566 vs 247 t/s. I had been running 3 for weeks because it was in the first config
that worked.

## What each adopted knob bought (measured, not vibes)

| knob | gain | notes |
|---|---|---|
| `--spec-type draft-mtp,ngram-map-k4v` (all defaults) | **+50–70% generation** (17→26-28; copy-heavy requests spike to 85 t/s at 100% acceptance) | costs prefill (see MTP tax below) — worth it because my workload is 77% generation time |
| NVIDIA card on **CUDA** backend, AMD on Vulkan (`-dev CUDA0,Vulkan2`) | **+28% prefill** no-spec, **+41% prefill** with the spec stack (376→532) | gen identical; verdict is arch-dependent — CUDA's q8_0-KV decode collapses −50% at depth on dense models, fine on hybrid-SSM |
| `--spec-draft-n-max 2` (down from 3) | **2.3x prefill** (247 → 566 t/s), generation unchanged | Q6-only cliff: Q3 and Q4 are FLAT across n-max 1–4. Replicated 4/4 in alternating order, cooldown-gated. Costs nothing — n-max 3 was simply worse |
| `--spec-draft-device CUDA0` | **+8% prefill** (532→573) | free; found while testing a workaround for the MTP tax |
| `-fitt 256` | **+60k context** (202k→262k) | llama's fit estimator refuses launches that actually fit; this shrinks its margin |
| rebuild llama.cpp (2 weeks newer) | **+13% generation** free (25.0→28.3, identical config) | also made all my careful spec tuning obsolete (below) |
| UD-Q6_K_XL over Q8_0 | +9% gen, +3GB context, equal prefill | ONLY on CUDA — on Vulkan, Q8 prefills 12% faster (K-quant dequant is expensive in RADV, free in CUDA) |
| q8_0 KV cache | 262k context vs ~190k | costs −23% prefill/−9% gen at depth in llama-bench, but only −7.5% prefill in the real server; took the context |
| `-ts 40,60` (VRAM-proportional) | baseline | ±5 points moves ~2%; not worth tuning further |

## What I tried that did NOT help (this list cost me ~two days, take it for free)

| attempt | result |
|---|---|
| `-ub 1024` / `2048` (the classic "raise ubatch for prefill") | **−13% / −31% prefill.** Inverts on multi-GPU layer split — smaller chunks pipeline better across cards |
| `-b 4096` | +9% in llama-bench, **exactly 0% in the real server.** Bench your production path before adopting anything |
| ngram tuning (min-hits, draft length M/N, p-min) | won +17% on the old build; after rebuilding, ALL deltas collapsed into noise. **Re-tested properly at n=10 with thermal gating: min-hits 2 lands +0.17 t/s (t=0.13) against pooled controls.** Verified null. Run defaults |
| `--spec-draft-n-min` (any value) | null on both prefill and generation; the two identical controls differed by 7x more than the knob did |
| `--spec-ngram-map-k4v-size-m 96` | −9% prefill. Bigger M is actively bad |
| `--spec-draft-p-min 0.5` | raised draft acceptance to **68%, the highest I measured** — and produced exactly zero generation gain. Acceptance is a diagnostic, not a target |
| raising tensor split past `40,60` at n-max 2 | won't allocate at all (OOM at ts41). 40/60 is already the ceiling for Q6 at 262k |
| `ngram-mod` (adaptive ngram) | −17% generation |
| a trained DSpark draft head for my exact model | 1–5% acceptance (GGUF mislabeled dflash), 33% forced as dspark — still 3× slower than MTP+ngram. Trained drafters aren't plug-and-play yet |
| `-sm row` | structurally impossible: Vulkan backend has no split-buffer support at all, CUDA's needs 2+ CUDA cards |
| mixed KV types (`-ctk q8_0 -ctv f16` or mirror) | **4–13× prefill collapse** — silent kernel fallback; KV types must match |
| `-fa 0` | can't even launch: quantized KV requires flash attention |
| raising the 80W power cap | firmware says no (laptop); also irrelevant — gen is bandwidth-bound and prefill was kernel-bound |
| all-Vulkan pairing (revisited after the MTP findings) | 376 vs 532 prefill with the spec stack; gen equal — CUDA pairing survived four separate challenges |

## The traps (each one silent, each one an hour)

- llama-bench `-dev A,B` benchmarks each device SEPARATELY; `A/B` is the split. My
  first "pair" results were solos wearing pair labels.
- Repeated flags in llama-bench build a test MATRIX (two `-fa`s = both configs run).
- `-fa 0` + quantized KV fails at context creation with an unhelpful error.
- The fit estimator adds the spec/MTP context to its safety margin — spec-enabled
  launches get refused earliest.
- A GGUF finetune conversion can silently drop the MTP head (mine did — block_count
  40 vs the base's 41).
- HF cache revisions coexist: `hf download` of an updated repo does NOT update your
  pinned paths; I "benchmarked the new model" twice before noticing my profile still
  pointed at the old snapshot.

## The MTP detective story (condensed — this is the fun section, keep it)

Noticed prefill halved with `draft-mtp` on. Chased it through four theories, each
killed by the next measurement: my eGPU (no — measured), the prompt being processed
twice (real but too small), CUDA graph re-capture (artifact of a mislabeled run), and
finally the truth: **the per-ubatch draft catch-up decode breaks multi-GPU ubatch
pipelining** — single GPU pays 1.03–1.22×, ANY layer split pays 1.8–2.0×, either
backend. Filed upstream: [ISSUE LINK]. Along the way my acceptance numbers
independently corroborated #26750 (MTP acceptance collapses on CUDA: 41% vs 64% on
Vulkan, same file) — so there are two pending upstream fixes that would give this rig
another ~2× prefill and +20% gen without touching a flag.

## The n-max cliff (the second detective story, and I got it wrong twice)

`--spec-draft-n-max 3` → prefill 247 t/s. `n-max 2` → 566. Same model, same everything
else, minutes apart. Each extra draft token costs a fixed **+262 MiB** of VRAM on the
4090 (identical steps on Q3 and Q6 — it's the per-branch recurrent state a hybrid
linear-attention model needs), and Q6 at 262k context sits right where that starts to
hurt.

Three mechanisms I proposed, and how each died:

1. **VRAM capacity cliff.** Killed by forcing Q3 onto the 4090 via tensor split until
   it used **15873 MiB — *more* than Q6's slow runs — where it ran at 655 t/s, the
   fastest reading in the whole ladder.** No memory cliff.
2. **Pipeline-parallelism fallback.** llama.cpp silently retries without pipeline
   parallelism when a compute buffer won't fit, which would neatly halve split
   prefill. Killed by reading the log of a collapsed run: `pipeline parallelism
   enabled`.
3. **Thermal.** Killed by replication — the *slow* runs started up to 17 °C **cooler**.

A `-lv 5` startup diff between the fast and slow configs shows identical compute
buffers, identical graph splits, identical sched copies, +144 graph nodes and +12 MiB.
**So the mechanism is still unknown** — it's a runtime effect, not a configuration or
allocation one. I'm posting it unsolved because the practical answer doesn't depend on
it: n-max 2 is strictly better, and if anyone recognises the signature I'd love to
know.

## The methodology reckoning (the part I'd actually want to read)

Two of the conclusions in my own earlier write-up were **wrong**, and both failed the
same way:

- An identical control config, re-run through one night, spanned **24.8–38.7 gen t/s
  — a 48% spread.** Every knob difference I'd been chasing was smaller than that.
  `corr(GPU temp, gen t/s) = −0.59`.
- The fix was a **cooldown gate** (idle until the GPU drops below a target before each
  config) plus manual fan control. Per-config standard deviation went from that 48%
  spread to **0.15–0.47 t/s** — enough to resolve sub-1% differences.
- At **n=3**, min-hits 2 looked like a clear winner, outside the control spread. At
  **n=10** it was +0.17 t/s. **Three reps cannot resolve generation differences on
  this rig.** If you take one thing from this post, take that one.

Two sensor traps worth knowing, both of which fooled me:

- **nvidia-smi's throttle *counters* are useless.** Measured incrementing ~11 s per
  20 s of wall time on a **50 °C idle** GPU. "82% of uptime thermally throttled" means
  nothing.
- **`sw_thermal_slowdown` asserts at idle/low clocks**, not when hot. On my card it
  fires throughout model load at 40–52 °C and goes *quiet* under full compute at
  60–63 °C. It means "clocks below max". Only `hw_thermal_slowdown`, or a sw flag
  corroborated by an actual temperature, is meaningful. (`sw_power_cap` is
  permanently lit on a power-limited laptop GPU and is not a thermal signal either.)

And one measurement trap specific to A/B harnesses: **if you send the same prompt
twice, the second one hits the KV cache** (`f_sim_best = 1.000`) and reprocesses ~4
tokens. Its "prompt t/s" is fixed overhead, not a rate. Only the first rep measures
prefill.

## What I have NOT measured (be suspicious of the above)

**Everything here is at ≤22k prompt tokens.** Real sessions run to 262k, prefill
visibly degrades at depth, and no knob above has been tested there. There's reason to
expect it matters: the f16-vs-q8_0 KV gap widens from +2% at d0 to +23% at d98k, and
the ngram knobs index a token-history map that *grows with the conversation*. The
depth harness is written; results are a future post.

## Method notes (why I trust these numbers)

- llama-bench for hardware questions, real llama-server A/Bs for anything involving
  speculation — llama-bench can't measure spec at all.
- **Identical control configs bracketing every batch.** The control-vs-control spread
  IS the resolution limit; any effect smaller than it is not a finding. This is what
  caught both of my wrong conclusions.
- **10 reps for generation, cooldown-gated.** 3 reps produced a false positive that
  10 reps killed.
- **Alternating/reversed config order**, so drift shows up as controls disagreeing
  rather than as a fake result. The n-max finding was confirmed by running the ladder
  backwards and getting the same answer.
- Bench wins were CONFIRMED against the server before adoption after `-b 4096`
  taught me they don't transfer (0 of 1 transferred fully; f16-KV transferred at
  ~1/3 strength).
- Every number in this post came from a run I can re-execute in ~10 minutes.
  [Optionally: link BENCH-FINDINGS.md as a gist for the full tables.]

## Final config

```
llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf -c 262144 -ngl 999 -fa on \
  -ctk q8_0 -ctv q8_0 --spec-type draft-mtp,ngram-map-k4v --spec-draft-n-max 2 \
  --spec-draft-device CUDA0 --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60 \
  --jinja -fitt 256
```

## Before posting

- [ ] Insert the upstream issue URL (two places)
- [ ] Decide whether to gist BENCH-FINDINGS.md and link it
- [ ] Rewrite in your own voice (same rule as the issue — the tables can stay)
- [ ] Screenshot candidates: the isolation matrix, a Monitor session graph, the
      n-max prefill cliff (247 vs 566), the 48%-spread control chart before/after
      thermal gating
- [ ] Decide whether to include the unsolved n-max mechanism as a call for help
      (recommended — "here's a reproducible 2.3x cliff I can't explain" invites the
      one person who knows)
