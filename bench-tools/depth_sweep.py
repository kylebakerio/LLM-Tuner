#!/usr/bin/env python3
"""Depth sweep: measure prefill and generation as context grows to the ceiling.

WHY incremental: each turn appends a chunk and the KV cache carries forward, so
we prefill the delta only -- which is both ~10x cheaper than re-prefilling at
every checkpoint AND exactly what real agentic use does. The measured
"prompt t/s" at depth D is therefore "rate of processing new tokens when the
cache is already D deep", which is the number that actually degrades in
practice.

Corpus is the user's own source files (real code they work on) chunked into
turns; a real opencode transcript can be dropped in via --corpus.
"""
import argparse, json, os, re, signal, subprocess, time, urllib.request

BIN = "/home/kyle/AI/llama-official/llama.cpp/build-cuda-vulkan/bin/llama-server"
Q6 = ("/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/"
      "snapshots/27af057ecb382ddfea5d12837360a8980560e3ed/Qwen3.8-27B-UD-Q6_K_XL.gguf")
TMP = "/home/kyle/.claude/jobs/08353f7d/tmp"
PORT = 18100
SRC = "/home/kyle/AI/experiment-1/dashboard"
CORPUS_FILES = ["script.js", "server4.js", "index.html", "monitor.py",
                "BENCH-FINDINGS.md", "README.md"]
REQUESTS = [
    "Review this file for bugs. List only real defects, with line references.",
    "What does this code do? Summarise the control flow in a few sentences.",
    "Identify any resource leaks or unbounded growth in this file.",
    "Point out anything here that would behave differently under load.",
    "Are there error paths in this file that fail silently?",
]

def gpu_temp():
    try:
        return int(subprocess.check_output(
            ["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
            timeout=10).decode().strip().splitlines()[0])
    except Exception:
        return None

def cool(limit, max_wait=900):
    if not limit:
        return gpu_temp()
    t0 = time.time()
    while time.time() - t0 < max_wait:
        t = gpu_temp()
        if t is None or t <= limit:
            return t
        time.sleep(10)
    return gpu_temp()

def load_chunks(chunk_chars, corpus=None):
    """Realistic turns: real source, cycled with varied framing (an agent does
    re-read files, so some repetition is honest -- but the framing differs)."""
    if corpus:
        text = open(corpus, encoding="utf-8", errors="replace").read()
        blobs = [text]
    else:
        blobs = []
        for f in CORPUS_FILES:
            p = os.path.join(SRC, f)
            if os.path.exists(p):
                blobs.append(open(p, encoding="utf-8", errors="replace").read())
    chunks, i = [], 0
    for blob in blobs:
        for off in range(0, len(blob), chunk_chars):
            piece = blob[off:off + chunk_chars]
            if len(piece) < chunk_chars // 2:
                continue
            chunks.append(f"{REQUESTS[i % len(REQUESTS)]}\n\n```\n{piece}\n```")
            i += 1
    return chunks

def parse_last(logtxt):
    """Most recent prompt-eval and eval rates + context depth from the log."""
    pref = gen = ntok = None
    for line in logtxt.splitlines():
        if "print_timing" not in line:
            continue
        last = line.split("|")[-1].strip()
        m = re.search(r"=\s*[\d.]+\s*ms\s*/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second", last)
        if last.startswith("prompt eval time") and m:
            pref, ntok = float(m.group(2)), int(m.group(1))
        elif last.startswith("eval time") and m:
            gen = float(m.group(2))
    return pref, gen, ntok

def run_config(tag, extra, args):
    start_t = cool(args.cool)
    log = os.path.join(TMP, f"depth_{tag}.log")
    cmd = [BIN, "-m", args.model, "-c", str(args.ctx), "-ngl", "999", "-fa", "on",
           "-ctk", "q8_0", "-ctv", "q8_0",
           "--spec-type", "draft-mtp,ngram-map-k4v",
           "--spec-draft-device", "CUDA0", "--split-mode", "layer",
           "-dev", "CUDA0,Vulkan2", "-ts", "40,60", "--jinja", "-fitt", "256",
           "--port", str(PORT)] + extra
    with open(log, "w") as fh:
        p = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT, preexec_fn=os.setsid)
    points, messages = [], []
    try:
        for _ in range(500):
            time.sleep(2)
            txt = open(log).read() if os.path.exists(log) else ""
            if "model loaded" in txt:
                break
            if "cudaMalloc failed" in txt or "failed to load" in txt:
                return {"tag": tag, "error": "load failed"}
        time.sleep(3)
        chunks = load_chunks(args.chunk_chars, args.corpus)
        depth = 0
        for idx, chunk in enumerate(chunks):
            if depth >= args.target:
                break
            messages.append({"role": "user", "content": chunk})
            body = json.dumps({"model": "x", "max_tokens": args.gen,
                               "stream": False, "messages": messages}).encode()
            req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions",
                                         data=body, headers={"Content-Type": "application/json"})
            t0 = time.time()
            try:
                resp = json.loads(urllib.request.urlopen(req, timeout=2400).read())
            except Exception as e:
                points.append({"turn": idx, "error": str(e)[:120]})
                break
            wall = time.time() - t0
            # keep the assistant turn so context grows the way real use does
            msg = (resp.get("choices") or [{}])[0].get("message", {})
            messages.append({"role": "assistant", "content": msg.get("content", "")})
            usage = resp.get("usage", {}) or {}
            depth = usage.get("prompt_tokens", depth)
            pref, gen, newtok = parse_last(open(log).read())
            pt = {"turn": idx, "depth_tokens": depth, "new_tokens": newtok,
                  "prefill_tps": pref, "gen_tps": gen, "wall_s": round(wall, 1),
                  "gpu_temp": gpu_temp()}
            points.append(pt)
            print(f"  [{tag}] turn {idx:2d} depth {depth:>7} new {str(newtok):>6} "
                  f"prefill {pref} gen {gen} {pt['gpu_temp']}C", flush=True)
        return {"tag": tag, "start_temp": start_t, "points": points}
    finally:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            pass
        time.sleep(8)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=Q6)
    ap.add_argument("--ctx", type=int, default=262144)
    ap.add_argument("--target", type=int, default=150000)  # corpus reach; a real transcript extends this
    ap.add_argument("--chunk-chars", type=int, default=24000)  # ~6k tokens/turn
    ap.add_argument("--gen", type=int, default=192)
    ap.add_argument("--cool", type=int, default=65)
    ap.add_argument("--corpus", default=None)
    ap.add_argument("--out", default=os.path.join(TMP, "depth_results.json"))
    args = ap.parse_args()

    configs = [
        ("nmax2", ["--spec-draft-n-max", "2"]),
        ("nmax2-hits2", ["--spec-draft-n-max", "2", "--spec-ngram-map-k4v-min-hits", "2"]),
        ("nmax3", ["--spec-draft-n-max", "3"]),
    ]
    out = []
    for tag, extra in configs:
        print(f"=== {tag} ===", flush=True)
        r = run_config(tag, extra, args)
        out.append(r)
        with open(args.out, "w") as fh:
            json.dump(out, fh, indent=1)
    print("DONE", flush=True)

if __name__ == "__main__":
    main()
