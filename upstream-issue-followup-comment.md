# Draft follow-up comment — review and edit into your own words before posting
# (same rule as the original issue: their contribution guide prohibits AI-drafted
#  content, treat this as notes/structure, rewrite anything that doesn't sound like you)

Update: tried a local fix, it didn't work, but the result is informative.

**Attempt 1 — defer/batch the catch-up decode.** My theory was that the per-ubatch
synchronous catch-up decode in `process()` was breaking cross-device ubatch
pipelining on a layer split. I patched it to accumulate catch-up tokens into the
existing batch and flush once per `n_batch`-sized chunk (or at `begin()`/`draft()`)
instead of decoding every single prefill ubatch. Draft acceptance and mean-len
stayed healthy after the patch (49.6%, 2.49), so the accumulation itself was
working correctly. Prefill didn't recover at all though -- 554.5 t/s, right in the
same 527-573 band as unpatched.

**Attempt 2 — just skip the catch-up decode entirely.** To sanity-check whether the
decode itself was even the right target, I gated it out completely with an env var
(diagnostic only -- draft quality goes to ~0%, obviously not shippable). Ran a clean
three-way A/B on the same harness (Qwen3.8-27B Q6_K_XL, CUDA0+Vulkan2 split, 40/60,
q8_0 KV, 262k ctx, 22k-token cold prompt):

| variant | prefill t/s | graphs reused | draft acceptance |
|---|---|---|---|
| ngram-map-k4v only (no MTP) | 988.7 | 254 | n/a |
| draft-mtp (normal) | 557.7 | 112 | 41.3% |
| draft-mtp, catch-up decode skipped entirely | 606.1 | 246 | 0.8% (expected -- stale draft KV) |

Deleting the catch-up decode completely only recovers about 9% of the gap
(557.7 -> 606.1, vs the 988.7 ceiling), nowhere close to closing it. So the
per-ubatch catch-up decode isn't actually the dominant cost -- something about
having `--spec-type draft-mtp` active at all is eating the other ~90%,
independent of that decode.

One more thing that surprised me: `graphs reused` recovers almost fully when the
decode is skipped (246, close to the no-MTP 254) even though prefill throughput
doesn't follow. I'd been using that counter as supporting evidence for the
pipelining theory in my original report -- I'd now discount it, since it clearly
isn't a reliable proxy for the actual throughput cost.

I don't have a profile-level answer for what the remaining cost is -- tracing
`server-context.cpp` I found a comment suggesting MTP forces per-position output
requests on the target during prefill (`/* output = */ slot.need_embd()` near
"MTP also wants logits at every prompt position"), but `need_embd()` traces back to
being unconditionally false for completion tasks, so that specific path doesn't
obviously apply here. Would need an actual GPU trace (nsys/rocprof) to pin down,
which is past what I can do by reading source. Happy to test patches if anyone
has a specific hypothesis -- my repro takes about 10 min to rerun.

---
# ADDENDUM -- post this as a follow-up whether or not the above is already
# posted (works either way: appends to the same draft, or reads fine as a
# second comment continuing the thread). NOTE TO SELF (Kyle): pick one before
# posting depending on whether the first part already went up.

Update 2: found where the remaining cost actually lives, though not fully why yet.

Added timing instrumentation around two things: the target's own
`llama_decode(ctx_tgt, batch_view)` call in `server-context.cpp`, and (separately)
`llama_get_embeddings_nextn()` + the catch-up `llama_decode(ctx_dft, ...)` loop in
`speculative.cpp`. Ran the same 22k-token prompt on the same harness with
`draft-mtp,ngram-map-k4v` and with `ngram-map-k4v` alone, both traced. The 12
prefill ubatches are the same shape in both runs (42, 2048x8, 810, 512 tokens),
and `has_output` is false on all 12 in both -- so it's not the per-token output
flag I guessed at last time.

| phase | draft-mtp | ngram-only | ratio |
|---|---|---|---|
| target's own decode (12 prefill ubatches) | 33422.6 ms | 18342.6 ms | 1.82x |
| MTP catch-up total (decode + embedding read) | 2112.2 ms | n/a | -- |

~94% of prefill time is inside the target's own decode call, which never touches
the draft context. The catch-up decode is real but minor (~6%). This is
consistent both ways: removing the catch-up time from the MTP total predicts
~593 t/s if it were skipped, and my earlier skip-catchup test measured 606 t/s
independently. And the isolated ratio here (1.82x) matches the server-level
prefill ratio (974.6/548.8 = 1.78x) within 2%.

Also -- the ngram-only run's own load log prints `model has unused tensor
blk.64.nextn.eh_proj.weight -- ignoring` (and 3 sibling nextn tensors). With
draft-mtp active those tensors get wired into the forward graph instead (that's
what `llama_get_embeddings_nextn` reads). So the two runs' target forward passes
are measurably different graphs, not just different schedules -- not just an
inference on my part, it's in the load log.

My best guess for why this costs ~1.8x on a split but only ~1.03-1.22x solo
(from my original isolation matrix): serving the catch-up means the target has to
materialize the nextn hidden state for every position of every prefill ubatch,
not just sampled ones -- basically an all-positions-output workload riding along
on every ubatch. Small in raw FLOPs, but that shape might be exactly what forces
a per-ubatch pipeline drain on a layer split (nothing to drain on one GPU, real
cost across two) -- which would also explain why `graphs reused` tracks the
catch-up interleave specifically (it recovers fully when catch-up is skipped)
without tracking this bigger cost. That's a guess, not confirmed -- pinning it
down for real would need either disabling the nextn materialization on the
target side directly, or an actual GPU trace.

Update 3: got a GPU trace on both sides after all -- turns out `nsys` needs no
special permissions for basic CUDA tracing, and the AMD side has kernel-level
scheduler tracepoints (`amdgpu`/`gpu_scheduler` via `perf`) that don't need ROCm
at all, just root once.

CUDA0 side (nsys, NVTX ranges around the same functions): projecting the
`tgt_decode` NVTX range onto the GPU timeline shows the range is only ~82%
covered by attributed GPU work with draft-mtp on, vs ~90% with ngram-only -- so
there's more idle time, but the bigger effect is that the GPU-attributed span
itself is 1.66x longer (27.3s vs 16.4s total across the 12 prefill ubatches).
CUDA0 isn't just waiting more, it's measurably doing more/slower work too.

AMD side (perf, `drm_sched_job_run`/`drm_sched_job_done` tracepoints): this is
the stronger signal. Measured the idle time on the AMD scheduler queue --
time between a job finishing and the next one starting, anywhere on the
device -- during each run's prefill window:

| | prefill window | idle time on AMD's queue | largest gaps |
|---|---|---|---|
| draft-mtp | 36.8s | 46.1% | two gaps near 1 second each |
| ngram-only | 19.9s | 10.2% | one ~1s outlier, rest under 400ms |

The AMD card sits idle 4.5x more (as a fraction of prefill time) with MTP on.
Both runs have a ~10% idle baseline even without MTP (probably just normal
pipeline-bubble cost of any two-device split) -- MTP adds ~36 points on top.
Worth noting `--spec-draft-device CUDA0` pins the catch-up decode entirely to
the NVIDIA card, so the AMD card structurally has nothing to do while it runs
(measured at ~2s total) -- but that only predicts about 6% of AMD idle time,
not the 36-point jump actually measured, so most of this isn't simply "waiting
out the catch-up decode." It's consistent with the CUDA0 finding though: if
CUDA0 itself is taking 1.66x longer, the AMD card's next input arrives later
too, which would extend its idle wait well beyond the catch-up window alone.

So: both sides of the actual split show real, mutually-consistent degradation
under MTP -- CUDA0 doing more/slower work, AMD idling much more -- and together
they roughly account for the ~1.8-3.4x tax range measured across pairings. I
still don't have a source-level root cause (that'd mean reading/instrumenting
the ggml scheduler and graph-capture code directly, past what black-box tracing
can tell you), but this is a lot more concrete than "something about MTP being
active costs ~40%" from my last update.

Instrumentation (timestamps, NVTX ranges, and the AMD trace script) is up at
[branch/commit link if you want to share the mtp-diag branch] if anyone wants
to reproduce or extend it.
