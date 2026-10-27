#!/usr/bin/env node
import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import readline from 'node:readline';
import { loadConfig } from './src/config.js';
import { McClient } from './src/client.js';
import { createAppStore } from './src/state.js';
import App from './src/app.js';
import { listProfileState, saveProfile, deleteProfile } from './src/profiles.js';
import { profileTag } from './src/launchconfig.js';
import { isStrataConfig, profileModelLabel, profileListRows } from './src/launchplan.js';
import { normalizeTopology } from './src/topology.js';
import { portFromCommand, modelName, isLaunchableModel } from './src/format.js';

// The TUI runs in the terminal's alternate screen buffer (like vim/btop) --
// the mouse-click feature (src/mouse.js) needs the app to own a fixed,
// scroll-stable coordinate space (row 1 = the app's own first row) to map
// click coordinates to on-screen tabs/fields; Ink's normal inline rendering
// starts wherever the cursor happens to be and drifts with scroll position,
// which a click can't reliably account for. Normal terminal scrollback is
// unaffected -- it's exactly as it was before this session, restored the
// moment the alternate buffer is left.
const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_EXIT = '\x1b[?1049l';
let altScreenActive = false;
function enterAltScreen() { if (!altScreenActive) { altScreenActive = true; process.stdout.write(ALT_SCREEN_ENTER); } }
function exitAltScreen() { if (altScreenActive) { altScreenActive = false; process.stdout.write(ALT_SCREEN_EXIT); } }
// Crash-safety net: 'exit' handlers only get synchronous work, which a
// single escape-code write is.
process.on('exit', exitAltScreen);

const program = new Command();
program
  .name('llama-cli')
  .description('btop-style terminal UI for LL-Dash (llama.cpp dashboard)')
  .version('2.0.0');

// Token (tunnel-gate password) resolution: --token > MC_TOKEN > config.
function tokenFrom(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token') return argv[i + 1];
    if (a.startsWith('--token=')) return a.slice('--token='.length);
  }
  return process.env.MC_TOKEN || null;
}

// Masked password prompt on the TTY (runs BEFORE the ink TUI starts, so
// raw-mode stdin is safe). Returns null on Ctrl-C/empty/EOF. Prints * per
// character; the password itself is never echoed.
function promptPassword(question) {
  return new Promise((resolve) => {
    const t = process.stdin;
    if (!t.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      rl.question(`${question} (unmasked -- not a TTY): `, (ans) => {
        rl.close();
        resolve(ans.trim() || null);
      });
      return;
    }
    const wasRaw = t.isRaw;
    let pw = '';
    const cleanup = () => {
      t.setRawMode(wasRaw);
      t.removeListener('data', onKey);
      t.pause();
    };
    const onKey = (buf) => {
      const s = buf.toString();
      if (s === '\r' || s === '\n') { cleanup(); process.stdout.write('\n'); resolve(pw || null); return; }
      if (s === '\u0003') { cleanup(); process.stdout.write('\n'); resolve(null); return; }
      if (s === '\u007f' || s === '\b') {
        if (pw.length) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
        return;
      }
      if (s.length === 1 && s >= ' ') { pw += s; process.stdout.write('*'); }
    };
    process.stdout.write(question);
    t.setRawMode(true);
    t.resume();
    t.on('data', onKey);
  });
}

// Probe the tunnel gate. Returns 'open' (no gate), 'locked' (gate active,
// token missing/wrong), or the error message on a dead server.
async function probeGate(client) {
  try {
    await client.getJson('/api/tunnel');
    return 'open';
  } catch (err) {
    if (err.status === 401 || err.authRequired) return 'locked';
    return err.message;
  }
}

program
  .command('models')
  .description('List GGUF models (via the dashboard API)')
  .option('--all', 'also list mmproj files, draft heads and other non-model .gguf files', false)
  .option('-s, --server <url>', 'Dashboard URL', null)
  .option('--token <pw>', 'Tunnel-gate password', null)
  .action(async (opts) => {
    const cfg = await loadConfig();
    const client = new McClient(opts.server || cfg.server, {
      token: opts.token || tokenFrom(process.argv) || cfg.token || null,
    });
    try {
      const all = await client.getJson('/api/models');
      // models only unless --all (mmproj files, draft heads, template carriers are listed too)
      const models = opts.all ? all : all.filter(isLaunchableModel);
      console.table(models.map((m) => ({ name: modelName(m.name), size: m.size + ' GB', ...(opts.all ? { kind: m.kind || '-' } : {}), source: m.source, path: m.path })));
    } catch (err) {
      console.error(`Failed: ${err.message} (is the dashboard running?)`);
      process.exit(1);
    }
  });

const profileCmd = program.command('profile').description('Manage launch profiles (shared with the web dashboard, stored server-side)');

async function profileClient(opts) {
  const cfg = await loadConfig();
  return new McClient(opts.server || process.env.MC_SERVER || cfg.server, {
    token: opts.token || tokenFrom(process.argv) || cfg.token || null,
  });
}

profileCmd
  .command('list')
  .description('List saved profiles')
  .option('-s, --server <url>', 'Dashboard URL', null)
  .option('--token <pw>', 'Tunnel-gate password', null)
  .action(async (opts) => {
    let state;
    try {
      state = await listProfileState(await profileClient(opts));
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
    if (state.entries.length === 0) {
      console.log('No profiles found. Save one from Launch mode (p in the config editor) or:');
      console.log('  llama-cli profile save <name> -m <model.gguf> [-a "--ctx 8192 --ngl 99"]');
      return;
    }
    // Same order as the TUI's list: the profiles this machine can run first
    // (most recently used first), then the ones it can't, with the server's
    // reason. A server that sends no availability lists them all as before.
    const topology = normalizeTopology(state.topology);
    const rows = profileListRows(state.entries, { availability: state.availability, topology });
    if (topology) console.log(`machine: ${topology.signature}`);
    const HERE = { ready: 'yes', moved: 'yes (ids moved)', substitute: 'stand-in card', unavailable: 'no' };
    console.table(rows.map(({ name, config: p, avail, cards }) => {
      const type = profileTag(p);
      return {
        name,
        type,
        ...(state.availability ? { 'runs here': HERE[avail.status] } : {}),
        // where the launch sits (the server's placement text), or why it can't run here
        placement: cards,
        transport: type === 'RPC' && p.transport ? p.transport : '-',
        // a Strata-engine profile has a base config file instead of a model/build
        model: isStrataConfig(p) ? profileModelLabel(p) : (p.modelPath ? modelName(p.modelPath) : '-'),
        build: isStrataConfig(p) ? 'strata' : (p.build || '-'),
        ctx: p.ctx != null ? p.ctx : '-',
        ngl: p.ngl != null ? p.ngl : '-',
        args: p.argString || '-',
      };
    }));
  });

profileCmd
  .command('save <name>')
  .description('Save a minimal profile (full config editing happens in Launch mode)')
  .requiredOption('-m, --model <path>', 'Path to GGUF model')
  .option('-a, --args <string>', 'Raw launch args', '')
  .option('-c, --ctx <n>', 'Context size')
  .option('-g, --ngl <n>', 'Layers on GPU')
  .option('-s, --server <url>', 'Dashboard URL', null)
  .option('--token <pw>', 'Tunnel-gate password', null)
  .action(async (name, opts) => {
    try {
      await saveProfile(await profileClient(opts), name, {
        modelPath: opts.model,
        argString: opts.args,
        ctx: opts.ctx != null ? Number(opts.ctx) : undefined,
        ngl: opts.ngl != null ? Number(opts.ngl) : undefined,
      });
      console.log(`Saved profile "${name}"`);
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

profileCmd
  .command('delete <name>')
  .description('Delete a profile')
  .option('-s, --server <url>', 'Dashboard URL', null)
  .option('--token <pw>', 'Tunnel-gate password', null)
  .action(async (name, opts) => {
    try {
      await deleteProfile(await profileClient(opts), name);
      console.log(`Deleted profile "${name}"`);
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// livechat -- the running benchmark's conversation (codebench proxy tap), printed as it streams.
program
  .command('livechat')
  .description("Stream the running benchmark's agent/model conversation (needs codebench's record-proxy --tap)")
  .option('-s, --server <url>', 'Dashboard URL', null)
  .option('--token <pw>', 'Tunnel-gate password', null)
  .action(async (opts) => {
    const cfg = await loadConfig();
    const { runLivechat } = await import('./src/livechat.js');
    try {
      await runLivechat({ baseUrl: opts.server || process.env.MC_SERVER || cfg.server, token: opts.token || tokenFrom(process.argv) || cfg.token || null });
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// tunnel -- inspect/stop the Cloudflare quick tunnel from a REMOTE machine.
// This is the escape hatch: if you start the tunnel and then can't reach the
// dashboard locally, `llama-cli tunnel stop -s <url> --token <pw>` from here
// drops the tunnel AND the password gate.
const tunnelCmd = program.command('tunnel').description('Inspect or stop the Cloudflare quick tunnel (remote-safe)');

tunnelCmd
  .command('status')
  .description('Show whether the tunnel is up and its URL')
  .option('-s, --server <url>', 'Dashboard URL (or the tunnel URL)', null)
  .option('--token <pw>', 'Tunnel-gate password', null)
  .action(async (opts) => {
    const cfg = await loadConfig();
    const client = new McClient(opts.server || process.env.MC_SERVER || cfg.server, {
      token: opts.token || tokenFrom(process.argv) || cfg.token || null,
    });
    try {
      const st = await client.getJson('/api/tunnel');
      if (st.active) console.log(`tunnel: UP\n  url: ${st.url}`);
      else if (st.starting) console.log('tunnel: starting… (waiting for cloudflared)');
      else console.log('tunnel: down (no gate active)');
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

tunnelCmd
  .command('stop')
  .description('Stop the tunnel and drop the password gate')
  .option('-s, --server <url>', 'Dashboard URL (or the tunnel URL)', null)
  .option('--token <pw>', 'Tunnel-gate password', null)
  .action(async (opts) => {
    const cfg = await loadConfig();
    const client = new McClient(opts.server || process.env.MC_SERVER || cfg.server, {
      token: opts.token || tokenFrom(process.argv) || cfg.token || null,
    });
    try {
      await client.postJson('/api/tunnel', { action: 'stop' });
      console.log('tunnel stopped -- password gate dropped, local access restored');
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// Known subcommands; anything else is the TUI (so `llama-cli --server ...`
// reaches the TUI instead of erroring as an unknown commander option).
const KNOWN_SUBCOMMANDS = new Set(['models', 'profile', 'tunnel', 'livechat']);
const sub = process.argv[2];

function flagServer() {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '-s' || a === '--server') return process.argv[i + 1];
    if (a.startsWith('--server=')) return a.slice('--server='.length);
  }
  return null;
}

if (!KNOWN_SUBCOMMANDS.has(sub)) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('llama-cli (TUI) requires a terminal. Use a subcommand (models, profile, tunnel, livechat) for non-interactive use.');
    process.exit(1);
  }

  const cfg = await loadConfig();
  const serverUrl = flagServer() || process.env.MC_SERVER || cfg.server;
  const appStore = createAppStore();
  let token = tokenFrom(process.argv) || cfg.token || null;
  const client = new McClient(serverUrl, {
    onEvent: (e) => appStore.onSSEEvent(e),
    onConnState: (c) => appStore.onConnState(c),
    token,
  });

  // If the dashboard's tunnel gate is active and we have no (valid) token,
  // offer a masked password prompt BEFORE the TUI renders -- a gated server
  // would otherwise just spin on 401s in the status bar. Up to 3 tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    const gate = await probeGate(client);
    if (gate === 'open') break;
    if (typeof gate === 'string' && gate !== 'locked') {
      console.error(`Failed to reach ${serverUrl}: ${gate}`);
      process.exit(1);
    }
    if (token) { console.error('Failed: that password was rejected by the tunnel gate.'); process.exit(1); }
    const pw = await promptPassword('Dashboard is password-protected (tunnel gate). Password: ');
    if (!pw) { console.error('Aborted -- no password supplied. Re-run with --token <pw> or MC_TOKEN.'); process.exit(1); }
    token = pw;
    client.token = pw;
  }

  client.connect();

  // Telemetry poller (the server caches monitor.py samples; this never
  // shells out on the CLI side). The machine's topology (its cards and RPC
  // workers -- what Monitor's panels and Launch's labels are named from) is
  // asked for on the same timer, every 30s: it changes when a card or a build
  // does, not per sample. A server without the route leaves it unknown.
  let backfilled = false;
  let topologyAskedAt = 0;
  const TOPOLOGY_REFRESH_MS = 30000;
  const poll = async () => {
    if (Date.now() - topologyAskedAt >= TOPOLOGY_REFRESH_MS) {
      topologyAskedAt = Date.now();
      client.getJson('/api/topology').then((tp) => appStore.onTopology(tp)).catch(() => {});
    }
    try {
      const d = await client.getJson('/api/telemetry/latest');
      appStore.onTelemetry(d);
      if (!backfilled && d && d.stats) {
        // Flag success only AFTER the fetch resolves: if the first attempt
        // fails (dashboard mid-restart), the next poll retries instead of
        // the completions table staying empty forever. Duplicate attempts
        // are harmless -- backfillCompletions dedupes by run_id.
        client.getJson('/api/logs/recent?limit=50')
          .then((r) => { backfilled = true; appStore.backfillCompletions(r.rows || []); })
          .catch(() => {});
      }
    } catch {
      // dashboard offline -- the SSE leg reports the state
    }
  };
  poll();
  const poller = setInterval(poll, Math.max(250, cfg.telemetryMs));

  enterAltScreen();
  const { waitUntilExit } = render(
    React.createElement(App, { client, appStore, serverUrl }),
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    client.close();
    clearInterval(poller);
    exitAltScreen();
  };
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });

  await waitUntilExit();
  shutdown();
} else {
  program.parse();
}
