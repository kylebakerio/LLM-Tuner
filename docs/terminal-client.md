# Terminal client (`dash-cli`)

`dash-cli/` is a btop-style terminal UI. It is a client of the dashboard, in
the same way the browser is: it starts no processes and keeps no state of its
own. The dashboard must be running.

This page is an overview. [dash-cli/README.md](../dash-cli/README.md) is the
full manual, covering every key, every slash command and the architecture.

## Install and run

```bash
cd dash-cli
npm install
node cli.js                 # the TUI (or: npm start)
node cli.js models          # list models
node cli.js profile list    # profiles, runnable-here first
node cli.js tunnel status   # is the tunnel up, and where
node cli.js tunnel stop     # stop it (drops the password gate)
```

## Modes

| Mode | Key | What it does |
|---|---|---|
| Monitor | `1` | One panel per GPU, t/s, context, recent requests and the log tail |
| Launch | `2` | Pick a profile, review the command the server resolves, and launch. Also has config editors for llama.cpp and Strata, and worker start/stop. |
| Chat | `3` | Streaming chat with attachments, thinking control and the web tools |

Keys that work everywhere:

- `?` shows the current screen's keymap.
- `q` quits, except in Chat, where it is typed as text.
- Ctrl-C quits.

Quitting leaves the model running.

## Configuration

The client reads `~/.llama-cli/config.json`, which has the keys `server`,
`telemetryMs` and `token`.

- **Server address.** It is taken from the first of these that is set:
  `--server` / `-s`, `MC_SERVER`, then the config file.
- **Password.** It is taken from the first of these that is set: `--token`,
  `MC_TOKEN`, then the config file.

To use the client from another machine, either:

- use an SSH port forward: `ssh -L 3000:localhost:3000 <host>`;
- or point `--server` at the tunnel URL. See the
  [README](../README.md#tunnel-and-password-gate).

## Notes

- **Command name.** The package's command is called `llama-cli`, which is the
  same as a llama.cpp tool. If you link it globally (`npm link`), check which
  one comes first on your PATH.
- **Not standalone.** `dash-cli` imports a module from `../ui/`, so it must stay
  inside this repository.
- **Tests.**
  - `npm test` (in `dash-cli/`) touches no server.
  - `bash test/live-cycle.sh` runs an end-to-end launch cycle against the
    **live** dashboard, and **stops the loaded model** for a minute or two.
    Don't run it while the GPUs are in use.
