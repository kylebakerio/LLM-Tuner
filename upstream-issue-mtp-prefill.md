# Draft GitHub issue — review and edit into your own words before posting
# (their rules prohibit AI-drafted issues; treat this as notes/structure,
#  rewrite anything that doesn't sound like you)

## HOW TO FILE (checklist)

1. github.com/ggml-org/llama.cpp/issues/new/choose -> "Eval bug" template.
2. Template fields:
   - Name and Version: `build 10499 (6d0549831)` (note in body: also on 6c8dcaa7a)
   - Operating systems: Linux
   - GGML backends: CUDA, Vulkan
   - Hardware: RTX 4090 Laptop 16GB (internal PCIe) + RX 7900 XTX 24GB
     (RADV, TB4 enclosure)
   - Models: unsloth/Qwen3.8-27B-GGUF (UD-Q6_K_XL, UD-Q3_K_XL),
     unsloth/Qwen3.6-35B-A3B-GGUF Q4_K_M
   - Problem description & steps: the "What happens" + matrix + repro below
   - Relevant log output: the log block at the bottom (all lines are real)
3. Before submitting: rewrite the prose in your own words; keep the tables.
4. After it's up:
   - drop the issue URL into reddit-post-outline.md §2 and tell Claude (goes
     into BENCH-FINDINGS + memory)
   - leave a short comment on #26750 with the acceptance numbers below
     (41% CUDA solo vs 64% Vulkan solo, same file) linking your new issue

Title: Eval bug: draft-mtp roughly halves prompt processing on multi-GPU layer split (single GPU is fine)

## What happens

With `--spec-type draft-mtp` enabled, prompt processing drops to roughly half speed
whenever the model is split across two GPUs with `--split-mode layer`. On a single GPU
the overhead is small. Same model file, same flags, only the device assignment changes.

I went down a few wrong paths on this (thought it was my eGPU, then thought it was
CUDA-specific) so I ended up with a fairly complete matrix. 22k token cold prompt,
prompt eval t/s from server timings:

| config | no MTP | draft-mtp | slowdown |
|---|---|---|---|
| Qwen3.8-27B Q3_K_XL, RTX 4090 solo (CUDA) | 766 | 742 | 1.03x |
| Qwen3.8-27B Q3_K_XL, 7900 XTX solo (Vulkan) | 572 | 505 | 1.13x |
| Qwen3.6-35B-A3B Q4_K_M, 7900 XTX solo | 1593 | 1307 | 1.22x |
| Qwen3.8-27B Q6_K_XL, CUDA0+Vulkan2 layer split | 973 | 532 | 1.83x |
| Qwen3.8-27B Q3_K_XL, CUDA0+Vulkan2 layer split | 1007 | 555 | 1.82x |
| Qwen3.8-27B Q6_K_XL, Vulkan1+Vulkan2 layer split | 754 | 376 | 2.0x |

("no MTP" rows use --spec-type ngram-map-k4v, which doesn't touch prefill and matches
the no-spec prefill rate. Last row is the same NVIDIA card via Vulkan instead of CUDA,
so no CUDA anywhere and it's still 2x; its no-MTP figure is llama-bench pp8192 on the
same split — bench and server rates agree within ~1% on the row where I have both.)

The `graphs reused` counter roughly halves with MTP on in every config (e.g. 960 ->
425 on the CUDA split pair, 897 -> 346 on Vulkan solo), but that on its own doesn't
seem to cost much — the solo rows eat the same reuse loss and barely slow down. The
expensive part only shows up when the layers are split across devices.

## Why I think this happens

UPDATE (2026-08-20): I tried to fix this locally and it made me less sure of the
mechanism -- see below. Leaving my original theory here since it's still plausible
context, but I no longer think it's the whole story.

Original theory: in common/speculative.cpp the MTP process() hook runs a synchronous
catch-up decode in the draft context for every prefill ubatch (unless the model is
mem-shared -- the "e.g Gemma4" comment). On a layer split that means every ubatch the
pipeline between the two GPUs gets broken by a decode on another context, so the
ubatch overlap (GGML_SCHED_MAX_COPIES) never gets going.

I patched process() to accumulate the catch-up tokens and flush them in n_batch-sized
chunks instead of decoding every single ubatch -- draft acceptance/mean-len stayed
healthy, so the patch itself worked, but prefill didn't recover at all (554.5 t/s,
same as unpatched). So I went further and just skipped the catch-up decode
completely (env-gated, diagnostic only -- draft quality goes to ~0%, not something to
actually ship): that recovered only ~9% of the gap (557.7 -> 606.1 t/s on a fresh
same-session control, vs a 988.7 t/s no-MTP ceiling on the same harness). So the
catch-up decode itself is NOT the dominant cost -- something about having
--spec-type draft-mtp active at all costs the other ~90% of the gap, independent of
that decode. `graphs reused` recovers almost fully when the decode is skipped (246,
vs 254 no-MTP) even though prefill throughput doesn't follow, so I'd now discount
graphs-reused as supporting evidence for whatever the real mechanism is. I don't have
a profile-level answer for what that remaining cost actually is.

## Environment

- build 10499 (6d0549831), also reproduced on 6c8dcaa7a from Aug 3 — not recent
- Linux, CUDA 12.0 + Vulkan build
- RTX 4090 Laptop 16GB (internal) + RX 7900 XTX 24GB (RADV)
- models: unsloth Qwen3.8-27B-GGUF (Q6_K_XL / Q3_K_XL), Qwen3.6-35B-A3B Q4_K_M —
  all with nextn_predict_layers=1
- -fa on, -ctk q8_0 -ctv q8_0

## Repro

```
# fast prefill:
llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf -c 262144 -ngl 999 -fa on \
  -ctk q8_0 -ctv q8_0 --spec-type ngram-map-k4v \
  --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60 --jinja

# ~half speed prefill, only --spec-type changed:
llama-server ... --spec-type draft-mtp --spec-draft-n-max 3 ...
```

Send any large cold prompt to both and compare `prompt eval time` in the timings.

## Related

#27306 looks like the same root cause at a different severity — that reporter
independently isolated the per-ubatch draft decode in common_speculative_process, and
on their hardware (RADV, ub 1024) it exceeds the Vulkan submit budget and device-losts
instead of just slowing down. Their diagnostic patch (skip the catch-up during the
prompt phase) would presumably also recover my 2x, though at the cost of stale MTP
state for the first drafts after prefill — so overlapping/batching the catch-up still
seems like the real fix.

Also possibly related: #26750 (draft-mtp acceptance collapse on CUDA vs Vulkan) — I
can reproduce that on this hardware too (41% acceptance CUDA solo vs 64% Vulkan solo,
same Q3 file), though it's a different symptom (decode quality, not prefill speed).

Tried `--spec-draft-device CUDA0` on the split as a workaround — helps a little
(532 -> 573) but doesn't recover the loss, so it doesn't look like it's about where
the draft context lives; the per-ubatch interruption of the target pipeline seems to
be the cost either way.

Happy to test patches, all of the above takes me ~10 min to rerun.

## Relevant log output (paste into the template field)

All lines below are verbatim from llama-server output (paths shortened).

```
# Q3_K_XL on the CUDA0,Vulkan2 layer split -- ngram vs draft-mtp:
llama-server -m Qwen3.8-27B-UD-Q3_K_XL.gguf -c 262144 -ngl 999 -fa on -ctk q8_0 -ctv q8_0 --spec-type ngram-map-k4v --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60 --jinja
slot print_timing: id  0 | task 0 | prompt eval time =   22122.60 ms / 22284 tokens (    0.99 ms per token,  1007.30 tokens per second)
slot print_timing: id  0 | task 0 |    graphs reused =        960

llama-server -m Qwen3.8-27B-UD-Q3_K_XL.gguf -c 262144 -ngl 999 -fa on -ctk q8_0 -ctv q8_0 --spec-type draft-mtp --spec-draft-n-max 3 --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60 --jinja
slot print_timing: id  0 | task 0 | prompt eval time =   40175.56 ms / 22284 tokens (    1.80 ms per token,   554.67 tokens per second)
slot print_timing: id  0 | task 0 |    graphs reused =        425

# same model, same card, single GPU (CUDA0 solo) -- overhead nearly gone:
llama-server -m Qwen3.8-27B-UD-Q3_K_XL.gguf -c 32768 ... --spec-type ngram-map-k4v -dev CUDA0 --jinja
slot print_timing: id  0 | task 0 | prompt eval time =   29107.22 ms / 22284 tokens (    1.31 ms per token,   765.58 tokens per second)

llama-server -m Qwen3.8-27B-UD-Q3_K_XL.gguf -c 24576 ... --spec-type draft-mtp --spec-draft-n-max 3 -dev CUDA0 --jinja
slot print_timing: id  0 | task 0 | prompt eval time =   30031.29 ms / 22284 tokens (    1.35 ms per token,   742.03 tokens per second)

# all-Vulkan split (no CUDA anywhere), draft-mtp -- still ~2x slower than its no-MTP rate:
llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf -c 262144 ... --spec-type draft-mtp,ngram-map-k4v --split-mode layer -dev Vulkan1,Vulkan2 -ts 40,60 --jinja
slot print_timing: id  0 | task 0 | prompt eval time =   59255.22 ms / 22284 tokens (    2.66 ms per token,   376.07 tokens per second)

# Vulkan solo graphs-reused pair (reuse halves, cost stays small):
slot print_timing: id  0 | task 0 |    graphs reused =        897   (ngram)
slot print_timing: id  0 | task 0 |    graphs reused =        346   (draft-mtp)
```
