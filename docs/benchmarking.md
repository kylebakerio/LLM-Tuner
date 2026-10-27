# Benchmarking

The **Bench** tab has three speed and quality tools of its own:

- `llama-bench` runs;
- launch sweeps;
- public coding suites.

LL-Dash can also act as the front end of an external coding-benchmark harness
(see [the last section](#external-benchmark-integration-optional)).

All benchmark output is also appended to `../logs/bench-history.log`. The tail
of that file is reloaded when the server starts.

## llama-bench

Open `Bench → speed · llama-bench`.

- **Inputs:**
  - a target: build, model, devices and split;
  - parameters: `-p`, `-n`, depths, repetitions, KV types, flash attention and
    extra arguments.
- **What to run:**
  - "Run form once";
  - matrix rows;
  - an "Auto Matrix" of solo and cross-GPU runs;
  - manual lines.
- **The queue runs on the server,** so it keeps going after you close the tab.
- **Benches refuse to start while a model is loaded,** because the model holds
  VRAM.

## Launch sweeps

Open `Bench → speed · spec sweep`.

A sweep launches the real `llama-server` once per config, so it measures
speculative decoding, which `llama-bench` cannot. For each config it:

1. optionally waits for the GPUs to cool to a target temperature;
2. sends a fixed prompt several times;
3. records the timings.

There are two runners:

- **The browser runner** runs in the page. Don't reload the tab while it runs.
- **The headless runner** runs inside the server (`/api/sweep/*`,
  `lib/sweep.js`).
  - It keeps its state in `sweep-state.json` and keeps going if you close the
    tab.
  - Drive it with `bench-tools/sweep-submit.py`:

```bash
# lines file: one sweep config per line (the format is parsed in lib/sweep.js)
python3 bench-tools/sweep-submit.py --lines sweep-lines.txt --prompt prompt.txt \
    --build <build-id> --reps 5 --gen-tokens 1024 --cooldown-c 60 --watch
python3 bench-tools/sweep-submit.py --status
python3 bench-tools/sweep-submit.py --stop
```

- **Pass `--build` explicitly.** Without it, the server picks the first build
  whose name mentions `cuda`.
- **Password gate.** When the gate is up, the script reads the password from
  `--password-file` and sends it as a Bearer token.

## Public suites

Open `Bench → quality · public suites`. These suites run against the model
being served, through its OpenAI-compatible `/v1` endpoint, so no reload is
needed. Two suites are available:

- **EvalPlus** (HumanEval+ or MBPP+), which needs the `evalplus` pip package.
- **Aider polyglot**, which needs the Aider benchmark checkout and the
  polyglot exercises at fixed paths under `~/code/suites/`, plus Docker. See
  `lib/suites.js`.

## depth_sweep.py

`bench-tools/depth_sweep.py` measures prefill and generation speed as the
context grows.

- It starts its own `llama-server` on port 18100.
- The binary, model and device list are hard-coded at the top of the file.
  Edit them before use.

## External benchmark integration (optional)

LL-Dash can also act as the front end of a separate coding-benchmark harness.
That harness is not part of this repository. When it is installed and
configured, LL-Dash adds the following:

- **A Bench sub-tab** for the harness, with:
  - a list of past runs;
  - a live view of the running agent, with its streamed conversation;
  - a leaderboard;
  - a form to start runs.
- **Quality results** next to speed on the Results tab.
- **A run queue.**
  - Its items are executed by the harness's own runner processes.
  - The runners work in named **lanes**: one per GPU, or one per remote
    machine.
  - The queue is stored in the dashboard's SQLite database.
  - The dashboard only edits the queue's rows. It never starts or stops a
    runner itself.
- **An auto-queue planner** that proposes queue items. Items are added only
  after you confirm them.

Without the harness these views are empty, and everything else works.
