# Depth testing — how to run it, and what to run

Written 2026-08-22 as a handoff. Everything in `BENCH-FINDINGS.md` §1–§15 was
measured at **≤22k prompt tokens**. Real usage runs to 262k, prefill visibly
collapses at depth, and **no knob has been tested there.** This doc covers the
harness for that and the tests worth running.

Harness: `bench-tools/depth_sweep.py`. **Written and reviewed, but never
executed** (the GPU was in use at handoff). Smoke-test it first:

```bash
# ~5 min, one config, shallow -- proves the whole path works end to end
python3 bench-tools/depth_sweep.py --target 20000 --cool 0 \
        --out /tmp/depth_smoke.json
```

Expect ~4 turns of output like
`[nmax2] turn 0 depth 6100 new 6100 prefill 588.0 gen 26.4 63C`, and a JSON
file with a populated `points` array. If `prefill` or `gen` come back `None`,
the log parser needs adjusting before any long batch is worth starting.

---

## 1. Why depth is a separate question

Depth is not a scaling factor on the shallow results; it can invert them.

- §1 already shows depth changes behaviour *qualitatively*: CUDA FA decode
  **collapses** at 98k on dense-attention models, and the f16-vs-q8_0 KV gap
  widens from +2% at d0 to **+23%** at d98k.
- The ngram knobs (`size_n`, `size_m`, `min_hits`) index a token-history map
  that **grows with the conversation**. A 48-token m-gram lookup over 9k of
  history is a different problem than over 200k. §15's null result at 9k does
  not transfer.
- `n-max`'s +262 MiB/draft-token is recurrent state for a hybrid
  linear-attention model. Whether the n-max 2 vs 3 gap (2.3× at 9k, §11) holds,
  widens, or inverts at depth is unknown.

So the two headline results — **n-max 2 wins**, **every other knob is null** —
are established only for shallow contexts.

---

## 2. Running the harness

```bash
python3 bench-tools/depth_sweep.py            # defaults: Q6, 3 configs, ~150k
python3 bench-tools/depth_sweep.py --help
```

Key options:

| flag | default | notes |
|---|---|---|
| `--target` | 150000 | stop each config at this depth |
| `--ctx` | 262144 | server `-c` |
| `--chunk-chars` | 24000 | ~6k tokens per turn |
| `--gen` | 192 | max_tokens per turn; keeps gen measurable without dominating runtime |
| `--cool` | 65 | wait for GPU ≤ this °C before each config (0 disables) |
| `--corpus` | none | path to a single text file to use instead of repo source |
| `--out` | `depth_results.json` | results |

**How it works, and why:** it grows one conversation incrementally — each turn
appends a chunk, the KV cache carries forward, so only the *delta* is prefilled.
That is (a) ~10× cheaper than re-prefilling at each checkpoint and (b) exactly
what real agentic use does. The measured `prefill_tps` at depth D is therefore
**"rate of processing new tokens when the cache is already D deep"** — the
number that actually degrades in practice. Assistant replies are kept in
history so context grows realistically.

Output is one JSON record per config with a `points` array:

```json
{"tag":"nmax2","start_temp":61,"points":[
  {"turn":0,"depth_tokens":6100,"new_tokens":6100,"prefill_tps":588.0,
   "gen_tps":26.4,"wall_s":19.1,"gpu_temp":63}, ...]}
```

Each config produces ~26 points. **Compare curves, not single numbers** — a
systematic offset sustained across 26 points at rising depth is strong evidence
even though each point is n=1.

Runtime ≈ 15 min/config (one 150k prefill + generation), so a 3-config batch is
under an hour.

### Before running

1. **GPU must be free.** `ps aux | grep llama-server` — the dashboard and this
   script will fight over VRAM and both fail. This happened repeatedly.
2. Set `--cool 65`. Without it, later configs run hotter and slower; see §4.
3. Kill it with `kill -9 <pid>; pkill -f llama-server`.

### Corpus — the weak link

Default corpus is the repo's own source (`script.js`, `server4.js`,
`index.html`, `monitor.py`, docs) — real code, ~156k tokens, 26 turns. That is
why `--target` defaults to 150000: **the corpus runs out before 262k.**

**A real opencode transcript is materially better and unlocks the full 262k.**
The ngram knobs index token history, so how repetitive the real context is
determines whether they help at all. Synthetic filler flatters the drafter;
prose penalises it. Only a real agentic session has the right mix of file
re-reads, diffs, tool output and phrasing. Capture one during normal work, then:

```bash
python3 bench-tools/depth_sweep.py --corpus /path/to/transcript.txt --target 250000
```

---

## 3. Tests worth running, in priority order

### T1 — Does the n-max 2 advantage hold at depth? (highest value)

The default config list already does this: `nmax2`, `nmax2-hits2`, `nmax3`.

This is the only test that could **change the daily config**. If n-max 3
overtakes n-max 2 past some depth, the recommendation flips for long sessions.
Read: does the 2.3× prefill gap persist, narrow, or invert as depth grows?

### T2 — Do the null knobs stay null at depth?

Re-test the ones whose mechanism is context-dependent. `min_hits` is already in
the default list for exactly this reason — it is the knob most likely to wake up
at depth, since its map grows with the conversation. Worth adding:

```python
("nmax2-M24",  ["--spec-draft-n-max","2","--spec-ngram-map-k4v-size-m","24"]),
("nmax2-N16",  ["--spec-draft-n-max","2","--spec-ngram-map-k4v-size-n","16"]),
```

Skip `n-min` (a per-draft length filter, context-independent) and `size_m 96`
(already known −9% prefill).

### T3 — Is speculative decoding still worth it at depth?

```python
("nospec", ["--spec-type","ngram-map-k4v","--spec-draft-n-max","2"]),
```

MTP costs ~1.8× prefill (§8) and buys ~+70% generation at shallow depth. Both
sides of that trade may move at 150k. If MTP's prefill tax grows faster than its
gen benefit, **disabling MTP for long sessions** becomes a real option — and
that would be a bigger win than any knob.

### T4 — KV cache type at depth

§4 measured f16 beating q8_0 by +23% prefill at d98k in llama-bench, but the
q8_0@262k decision was made on context capacity, not re-verified on the server
at depth with spec decoding active. `-ctk f16 -ctv f16` caps usable context at
~190k, so it is only interesting if you would trade ceiling for speed.
Lower priority — it changes a decision you already made deliberately.

### T5 — Where exactly does prefill fall off?

Any single run answers this from its own curve: plot `prefill_tps` vs
`depth_tokens`. Worth knowing whether it is smooth decay or a cliff at a
particular depth — a cliff would point at a kernel-dispatch threshold (the
mechanism suggested by llama.cpp issue #27444's comment about `fattn.cu`
switching from vec to MMA kernels at a size boundary).

---

### Known confound: depth vs heat

A run takes many minutes, so **later (deeper) turns are measured on a hotter
GPU** — and prefill is temperature-sensitive (`corr(temp, prefill) = -0.89`,
§13/§15). A declining prefill curve therefore mixes a depth effect with a
thermal one.

Two mitigations, both built in:

- Every point records `gpu_temp`. **Check it first.** If temperature is flat
  across the run, the curve is clean; if it climbs, some of the decline is heat.
- `--cool-every-turn` idles to `--cool` before *each* turn, isolating depth from
  thermal drift at roughly 2× runtime. Off by default because a real session
  also runs hot, so the uncooled curve is the more realistic one — but the
  cooled curve is the one that answers "is this depth or heat?".

Best practice: run uncooled first (realistic, faster), and if prefill declines
*and* temperature climbed, re-run the most interesting config with
`--cool-every-turn` to separate the two.

## 4. Methodology rules — learned the hard way, do not skip

These cost most of a session to establish. Ignoring them produces confident
wrong answers.

1. **Three reps cannot resolve gen differences on this rig; ten can.** An n=3
   pass showed `min_hits 2` apparently outside the control spread. At n=10 it
   was +0.17 t/s (t=0.13) — a false positive. Treat any n=3 gen result as a
   hypothesis.
2. **Always bracket with identical controls**, ideally more than one, spread
   through the batch. The control-vs-control spread *is* the resolution limit.
   Any effect smaller than it is not a finding.
3. **Thermal control is a prerequisite.** Without cooldown gating, an identical
   control config spanned **24.8–38.7 gen t/s (48%)** in one night.
   `corr(temp, prefill) = −0.89`. With a 60°C gate, per-config sd fell to
   **0.15–0.47 t/s**.
4. **Gate on GPU temp, not CPU.** The CPU package shares a heatpipe with the
   4090 and reads chassis heat: measured at 85% idle / 800–2800 MHz while
   sitting at 89°C. It lags; record it, do not gate on it.
5. **nvidia-smi throttle signals are unreliable here.** The lifetime counters
   tick ~11 s per 20 s of wall time on a **50°C idle** GPU.
   `sw_thermal_slowdown` asserts at idle/low clocks (it fires through model load
   at 40–52°C and goes quiet under load at 60–63°C) — it means "clocks below
   max", not "too hot". Only `hw_thermal_slowdown`, or a sw flag corroborated by
   ≥75°C, is meaningful. `sw_power_cap` is permanently active (80 W firmware
   cap) and is not a thermal signal.
6. **Repeated identical prompts hit the KV cache.** In the dashboard sweep, rep
   2+ reprocess ~4 tokens (`f_sim_best = 1.000`), so their "prompt t/s" is fixed
   overhead, not a rate. Only rep 1 measures prefill. The depth harness avoids
   this by always appending new content.
7. **Acceptance is a diagnostic, not a target.** `--spec-draft-p-min 0.5`
   produced the highest acceptance measured (68%) with *zero* gen gain.
8. **Randomise or reverse config order**, and check the controls agree. The
   reverse-order n-max run is what proved that result was real rather than drift.

---

## 5. State at handoff

**Settled (shallow, ≤22k):**
- `--spec-draft-n-max 2` — 2.3× prefill over 3, replicated 4/4 (§11)
- every other spec knob — verified null (§12, §15); `size_m 96` is −9% prefill
- daily config is in `BENCH-FINDINGS.md` under "Current daily config"

**Open:**
- Everything in §3 above (nothing measured past 22k)
- Mechanism of the Q6 n-max ≥3 prefill collapse. VRAM pressure, pipeline-
  parallelism fallback and thermal are all **falsified** (§11). The delta is
  isolated to +262 MiB of context allocation with identical compute buffers,
  splits, sched copies and pipeline state. Next tool would be the `MTP_TRACE` /
  NVTX instrumentation on branch `mtp-diag` (`e955b70ff`, `e6dcba49d`),
  comparing per-ubatch `tgt_decode` at n-max 2 vs 3. Practically moot —
  n-max 2 is simply better.
- **Security, unrelated but urgent:** `server4.js` listens on all interfaces
  (`LISTEN *:3000`) with no auth, and `/api/start` spawns
  `tokenizeCommand(config.rawCommand)[0]` — an arbitrary binary. That is
  unauthenticated **remote code execution** for anyone on the LAN.
  Cheapest fix: `server.listen(PORT, '127.0.0.1')`; reach it remotely via SSH
  port-forward.
