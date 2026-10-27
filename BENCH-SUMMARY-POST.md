# Two days of tuning a 7900 XTX + RTX 3060 llama.cpp rig — everything we learned

Hardware: RX 7900 XTX (24 GB) + RTX 3060 (12 GB) in one desktop, 32 GB DDR4;
a 4090 laptop (16 GB) reachable over wifi as an RPC node. Models: Qwen3.8-27B
(a hybrid arch, 16 attention layers of 65) at Q2–Q6, plus Qwen3.8-Flash-Next
(80B-class MoE, ~6B active). ~200 benchmark runs across 13 batches, all driven
through a headless API added to the dashboard mid-project, with bracketing
controls and ≥3 reps. Workload being tuned for: long agentic coding sessions
that fill 262k of context and compact — **87% prefill by tokens, but 70%
generation by wall time.**

## 1. Per-card baselines (Qwen3.8-27B Q2_K_XL, solo, uncapped)

| card / backend | prefill t/s | gen t/s | gen @98k |
|---|---|---|---|
| XTX ROCm | **910** | 37 | 22 |
| XTX Vulkan | 742 | **57** | **37** |
| 3060 CUDA | 505 | 22 | 12 |
| 3060 Vulkan | 250 | 16 | 11 |
| 4090 laptop CUDA | 795–850 | 25 | — |

- On the XTX, **ROCm wins prefill (~1.2×), Vulkan wins generation (~1.5×),
  and Vulkan's lead widens with depth** (1.5× → 1.9× at 196k).
- On the 3060, CUDA is 2× Vulkan on prefill; Vulkan there is the worst
  config measured anywhere.
- Quant barely changes which backend wins: IQ2_XXS vs Q2_K_XL moved the
  Vulkan/ROCm ratio by 0.3%.
- IQ2_XXS is ~15% faster on generation than Q2_K_XL for a 26% smaller file
  (decode is not purely bandwidth-bound: i-quant unpacking costs compute).
- Lifting power caps (300→376 W XTX, 144→212 W 3060) bought 3–9% for 25–47%
  more power. Thermal caps cost under 10%.

## 2. The "Vulkan got worse" question

Vulkan used to be comparable to CUDA on the 4090; on the 27B it was 15%
behind. Same machine, same session: on a dense 7B (qwen2.5-coder Q4_K_M)
Vulkan is **17% faster** than CUDA; on the hybrid 27B it is 15% slower. Nothing
regressed — CUDA is exceptionally optimized for this architecture and K-quants,
Vulkan is not. Corroborated by Vulkan *beating* ROCm on the same 27B.

## 3. Speculative decoding (MTP) — the biggest lever, on every backend

The model's own multi-token-prediction head (`--spec-type draft-mtp`) works on
ROCm, Vulkan and CUDA:

| backend | nospec | +MTP n2 | gain | draft acceptance |
|---|---|---|---|---|
| XTX ROCm | 32.8 | 61.1 | **+86%** | 82% |
| XTX Vulkan | 50.3 | 69.7 | +39% | 66% |
| 3060 CUDA | 18.8 | 28.8 | +53% | 68% |

- **Optimal draft depth is per-card**: XTX peaks at n2–n3 and falls off
  (n6 is 25% worse); the 4090 was still climbing at n4. Acceptance falls
  monotonically with depth and variance explodes (±3.7 at n1 → ±21.6 at n6).
- **n3 is useless at real depth**: identical to n2 at 131k (26.6 vs 26.6;
  acceptance drops exactly enough to cancel the longer draft).
- **ngram drafting is dead**: −7% stacked on MTP; +8% alone vs MTP's +63%.
- **MTP over RPC halves throughput** (an extra network round-trip per draft).
- Speculative configs are 25–100× noisier than plain decode (±6 vs ±0.1).
  Comparing MTP settings needs many reps; nospec needs one.

## 4. KV cache precision — the second lever, and it works through MTP

Quantizing the KV cache (q8_0) barely touches plain decode (+1.8% for f16) but
**degrades draft acceptance** (69% → 58%), which compounds:

| Q4_K_XL @131k, same everything | gen | pp |
|---|---|---|
| f16 KV + MTP | **26.6** | 601 |
| q8_0 KV + MTP | 21.4 | 595 |

+24% at 131k, +34% at 229k, +28% at 96k solo. It also raised prefill 27% in
one test. Cost: ~2× KV VRAM, i.e. roughly half the max context at a given
budget. **The earlier finding "MTP collapses at depth" was an artifact of q8
KV** — with f16 it retains +40% at 96k.

## 5. Quant size does NOT buy speed — it buys context

| @131k, 96k prompt | f16 KV | q8 KV |
|---|---|---|
| Q4_K_XL | 26.6 | 21.4 |
| Q6_K_XL | 24.9 | 21.0 |

Q6 vs Q4 at the same KV precision: −2 to −6%. Once the cache is 96k deep the
weights are a small share of bytes moved per token. **If your context fits at
Q6, run Q6; drop to Q4 only to fit more context.** Q3 is not faster than Q4
either (14.8 vs 15.3 at 262k) — it only lets f16 fit at full context.

## 6. Two cards: the split ratio is a WORKLOAD decision, not a VRAM one

Layer split is pipeline-parallel per token. Decode time = Σ(bytes on card ÷
that card's bandwidth); the 3060 is **2.7× slower per byte**, so at the
"natural" 2:1 VRAM split it eats 57% of decode time. Prefill is the opposite:
micro-batches pipeline across both cards, so more on the slow card raises
prefill.

| -ts (XTX:3060) | gen | pp | hours on the real workload |
|---|---|---|---|
| 1:1 | 17.0 | **769** | 49.0 |
| 2:1 (default) | 18.7 | 708 | 45.6 |
| 3:1 | 21.4 | 648 | 41.3 |
| **5:1** | **23.3** | 599 | **39.1** |

The bandwidth model predicts these within a few percent. At 70% generation by
time, **1:1 would only win past ~98% prefill**. Rule: agentic/chat → starve the
slow card; bulk-document workloads → load it up. Splitting a model that *fits*
on one card costs ~45% generation for +25% prefill — never worth it for speed.
The second card is for **capacity**: it makes Q6 loadable at all, f16 KV
possible at 262k, and Q4 reach 196k+ instead of 131k.

## 7. The draft head's placement unlocks the last 33k

Every "does not fit" at 262k was the 3060 running out by a few hundred MiB.
The MTP draft context is a few hundred MiB. Pinning it to the XTX
(`--spec-draft-device ROCm0`) made **Q4 + f16 KV + MTP fit at the full 262k**
(20.0 t/s) and Q4 + q8 + MTP fit at 262k. Draft device makes no speed
difference (24.0 vs 23.3) — it is purely a VRAM-placement trick. Heterogeneous
backends (`-dev ROCm0,CUDA0`) work fine in one process and gave the best pair
prefill (387 t/s at 262k).

**"Fits at load" ≠ "works" — the 262k f16+MTP profile is NOT usable.** The
kernel log shows three `llama-server` segfaults in `libamdhip64` (ROCm), one
per agentic attempt, each after exactly two served requests. Cause: at that
size the *compute buffers* don't fit on either card, and llama.cpp silently
falls back — `sched_reserve: compute buffer allocation failed, retrying without
pipeline parallelism` — then reports ready. That degraded path crashes on the
first request that reuses the prompt cache. The 229k profile reserves cleanly
(zero fallbacks) and is the daily driver. (I first blamed a competing GUI
launch for this; that launch was my own chain moving on after the crash.) The
sweep now flags rows that loaded via the fallback as `degraded`.

## 8. Final profiles (LL-Dash)

ROCm0+CUDA0, `-ts 3,1`, `--spec-type draft-mtp --spec-draft-n-max 2 -devd ROCm0`:
- **Q4 f16 KV @229k — 24.0 t/s** (24 t/s)
- **Q6 q8 KV @196k** (max context; ceiling still being mapped)
- **Q6 f16 KV @131k — 24.9 t/s** (best when 131k is enough)

## 9. Things that did not pan out

- **RPC over wifi**: 8 t/s for a VRAM-resident model (link saturates at
  ~180 Mbit, ~1.1 MB per generated token). 1 GbE should make the remote card a
  local-split peer; faster links add nothing.
- **Qwen3.8-Flash-Next (68–94 GB MoE) on 36 GB VRAM + 32 GB RAM**: 0.2–0.5 t/s
  from USB, **7.2 t/s from NVMe** — page-fault bound (~600 MB/s, ~2,400
  faults/s). RAM *capacity* is the lever; DDR5 bandwidth is not. Prefill stays
  single-digit, which on an 87%-prefill workload is hours per request. Waiting
  on 64 GB.
- **Upstream rebuild** (+499 commits): +13–21% on 3060 CUDA, neutral/−6%
  prefill on Vulkan, and mandatory for `qwen4exp`. Not a blanket win.
- **Abliterated 27B** (huihui): same speed without speculation, ~+17% with MTP
  (higher draft acceptance, but noisy: 63–77% run to run).

## 10. Methodology — the findings we had to retract

Every one of these was published, then disproved by re-testing:
1. "MTP collapses at depth on Vulkan" — q8 KV, not depth.
2. "CUDA MTP is broken upstream" — my test asked for f16 KV on a 12 GB card;
   fails identically on the old build.
3. "The abliterated model regressed 12% on the new build" — run-to-run noise.
4. "Q4 does not fit at 262k on the pair" — a grep matched a *non-fatal*
   warning and killed loads 1.4 s in; the second pass had port collisions.
   Q4 loads in 18 s.
5. "Q6 caps at 65k" — same broken instrument.

The common thread: **when a result contradicts something you have personally
run, suspect the instrument before the hardware.** Re-run the old binary with
the identical command and read the actual error line. Also: `/health` answers
200 while the model is still loading; readiness must be a real completion.
