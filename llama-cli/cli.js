#!/usr/bin/env node
import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from './src/config.js';
import { McClient } from './src/client.js';
import { createAppStore } from './src/state.js';
import App from './src/app.js';
import { listProfiles, saveProfile, deleteProfile } from './src/profiles.js';
import { portFromCommand } from './src/format.js';

const program = new Command();
program
  .name('llama-cli')
  .description('btop-style terminal UI for Mission Control (llama.cpp dashboard)')
  .version('2.0.0');

program
  .command('models')
  .description('List GGUF models (via the dashboard API)')
  .option('-s, --server <url>', 'Dashboard URL', null)
  .action(async (opts) => {
    const cfg = await loadConfig();
    const client = new McClient(opts.server || cfg.server);
    try {
      const models = await client.getJson('/api/models');
      console.table(models.map((m) => ({ name: m.name, size: m.size + ' GB', source: m.source, path: m.path })));
    } catch (err) {
      console.error(`Failed: ${err.message} (is the dashboard running?)`);
      process.exit(1);
    }
  });

const profileCmd = program.command('profile').description('Manage launch profiles (shared with the web dashboard, stored server-side)');

async function profileClient(opts) {
  const cfg = await loadConfig();
  return new McClient(opts.server || process.env.MC_SERVER || cfg.server);
}

profileCmd
  .command('list')
  .description('List saved profiles')
  .option('-s, --server <url>', 'Dashboard URL', null)
  .action(async (opts) => {
    let profiles;
    try {
      profiles = await listProfiles(await profileClient(opts));
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
    const keys = Object.keys(profiles);
    if (keys.length === 0) {
      console.log('No profiles found. Save one from Launch mode (press p) or:');
      console.log('  llama-cli profile save <name> -m <model.gguf> [-a "--ctx 8192 --ngl 99"]');
      return;
    }
    console.table(keys.map((name) => {
      const p = profiles[name];
      return {
        name,
        model: p.modelPath ? p.modelPath.split('/').pop() : '-',
        build: p.build || '-',
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
  .action(async (name, opts) => {
    try {
      await deleteProfile(await profileClient(opts), name);
      console.log(`Deleted profile "${name}"`);
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// Known subcommands; anything else is the TUI (so `llama-cli --server ...`
// reaches the TUI instead of erroring as an unknown commander option).
const KNOWN_SUBCOMMANDS = new Set(['models', 'profile']);
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
    console.error('llama-cli (TUI) requires a terminal. Use a subcommand (models, profile) for non-interactive use.');
    process.exit(1);
  }

  const cfg = await loadConfig();
  const serverUrl = flagServer() || process.env.MC_SERVER || cfg.server;
  const appStore = createAppStore();
  const client = new McClient(serverUrl, {
    onEvent: (e) => appStore.onSSEEvent(e),
    onConnState: (c) => appStore.onConnState(c),
  });

  client.connect();

  // Telemetry poller (the server caches monitor.py samples; this never
  // shells out on the CLI side).
  let backfilled = false;
  const poll = async () => {
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

  const { waitUntilExit } = render(
    React.createElement(App, { client, appStore, serverUrl }),
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    client.close();
    clearInterval(poller);
  };
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });

  await waitUntilExit();
  shutdown();
} else {
  program.parse();
}
