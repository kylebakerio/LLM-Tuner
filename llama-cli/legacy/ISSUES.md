# Known issues (code review, 2026-08-06)

Findings from reading through `cli.js` and `lib/{profiles,telemetry,parser,menu,tui}.js`
end-to-end. Nothing here has been run live yet -- flagged from reading the code only.
Roughly ordered by how much it matters for actual use of this tool on the current rig.

## Functional gaps

1. **No way to pick a build.** `getLlamaServerBinary()` (`cli.js:69-77`) checks the old
   single-path `cfg.llamaServerBinary` field first (no longer present in
   `dashboard.config.json`), then falls back to `cfg.llamaServerBuilds[0].path` --
   always the *first* configured build (currently `vulkan`), with no `--build <id>`
   flag to request another one. It can never launch the `vulkan-cuda` build by name;
   the only workaround is `-s/--server-binary` with a raw path.

2. **No multi-GPU device selection.** `doRun()` always spawns plain
   `llama-server -m <model> ...args` with no `-dev`/`-ts`/`--split-mode`. The
   dashboard's `local-multi-gpu` mode (device detection + split across two GPUs) has
   no equivalent here.

## Likely bugs

3. **README/code mismatch on polling rate.** `doRun()` calls `startTelemetry(5000)` --
   a 5s interval -- but the README claims 500ms polling with "~20 seconds" of
   sparkline history over the 40-point buffer (`README.md:75,77`). At the actual 5s
   interval the buffer spans ~200 seconds, not 20. One of the two is stale.

4. **Menu arrow-key navigation may not work reliably.** `lib/menu.js`'s
   `selectItem()` mixes a `readline.Interface` (cooked-mode line editing) with a raw
   `process.stdin.on('keypress', ...)` listener, but never calls
   `process.stdin.setRawMode(true)`. Without raw mode, the terminal's own line
   discipline handles arrow keys before the keypress handler sees them cleanly --
   readline's built-in history/cursor movement can compete with the up/down
   selection logic. Needs an actual terminal test; behavior may vary by terminal.

5. **`parser.js` log-format assumptions are unverified.** The regexes assume
   specific `llama-server` stdout lines (`"prompt processing, n_tokens = ..."`,
   `"print_timing: ... id X | task Y ..."`). Never confirmed against this build's
   actual log output -- worth watching the TUI on the next real launch to see
   whether prefill/gen t/s actually populate.

## Minor / polish

6. `scanDirRecursive`/`scanModels` are copy-pasted verbatim in both `cli.js` and
   `lib/menu.js` instead of shared.
7. `args.split(/\s+/)` in `doRun` breaks on any flag value containing a space
   (e.g. a quoted `--chat-template-kwargs '{"a": "b c"}'`).
8. `lib/tui.js` mixes an already-imported `get` from `telemetry.js` with two inline
   `require('./telemetry')` calls inside `renderGpuSection` -- cosmetic, but a sign
   this was assembled across more than one generation pass rather than one.

## What checks out

- The telemetry contract matches: `monitor.py`'s `do_POST` reads `worker_ssh` /
  `local_second_gpu` exactly as `telemetry.js` sends them, so that leg is fine.
