#!/usr/bin/env node
const { Command } = require('commander');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const chalk = require('chalk').default;

const { loadProfiles, saveProfile, deleteProfile, listProfiles } = require('./lib/profiles');
const { start: startTelemetry, stop: stopTelemetry, setUpdateCallback } = require('./lib/telemetry');
const { render: renderTUI, setupInput, cleanup: cleanupTUI } = require('./lib/tui');
const { parseChunk, reset: resetParser, setCtxSize } = require('./lib/parser');
const { launch: launchMenu, cleanup: cleanupMenu } = require('./lib/menu');

// Global safety net: ensure we can always exit
process.on('uncaughtException', (err) => {
  try { cleanupTUI(); } catch { /* ignore */ }
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  try { cleanupTUI(); } catch { /* ignore */ }
  console.error(chalk.red(`Fatal: ${err}`));
  process.exit(1);
});

async function scanDirRecursive(dir, depth = 0) {
  if (depth > 8) return [];
  let results = [];
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        results = results.concat(await scanDirRecursive(full, depth + 1));
      } else if (item.name.endsWith('.gguf')) {
        const stat = await fs.stat(full);
        results.push({ name: item.name, path: full, size: (stat.size / 1e9).toFixed(2) + 'GB' });
      }
    }
  } catch { /* skip inaccessible */ }
  return results;
}

async function scanModels() {
  const dirs = [
    path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
    path.join(process.cwd(), 'models'),
    path.join(os.homedir(), 'llama.cpp', 'models')
  ];
  let results = [];
  for (const dir of dirs) {
    results = results.concat(await scanDirRecursive(dir));
  }
  return results;
}

async function isPortOpen(port) {
  return new Promise(resolve => {
    const probe = net.createConnection({ port }, () => { probe.destroy(); resolve(true); });
    probe.on('error', () => resolve(false));
  });
}

const MONITOR_PATH = path.join(__dirname, '..', 'monitor.py');
const DASHBOARD_CONFIG = path.join(__dirname, '..', 'dashboard.config.json');

async function getLlamaServerBinary() {
  const defaultBinary = 'llama-server';
  try {
    const cfg = JSON.parse(await fs.readFile(DASHBOARD_CONFIG, 'utf-8'));
    if (cfg.llamaServerBinary) return cfg.llamaServerBinary;
    if (cfg.llamaServerBuilds && cfg.llamaServerBuilds.length > 0) return cfg.llamaServerBuilds[0].path;
  } catch { /* missing config */ }
  return defaultBinary;
}

const program = new Command();
program.name('llama-cli').description('CLI & TUI for llama.cpp management and monitoring').version('1.0.0');

program
  .command('models')
  .description('List available GGUF models')
  .action(async () => {
    console.log(chalk.grey('Scanning models...'));
    const models = await scanModels();
    if (models.length === 0) return console.log(chalk.yellow('No models found.'));
    console.table(models);
  });

const profileCmd = program.command('profile').description('Manage launch profiles');

profileCmd
  .command('save <name>')
  .description('Save launch config')
  .requiredOption('-m, --model <path>', 'Path to GGUF model')
  .option('-a, --args <string>', 'Additional llama-server arguments', '')
  .action(async (name, opts) => {
    try { await saveProfile(name, { model: opts.model, args: opts.args }); }
    catch (err) { console.error(chalk.red(`Failed: ${err.message}`)); process.exit(1); }
  });

profileCmd
  .command('list')
  .description('List saved profiles')
  .action(async () => await listProfiles());

profileCmd
  .command('delete <name>')
  .description('Delete a profile')
  .action(async (name) => {
    try { await deleteProfile(name); }
    catch (err) { console.error(chalk.red(`Failed: ${err.message}`)); process.exit(1); }
  });

async function doRun(model, args, serverBinary) {
  console.log(chalk.blue(`Starting llama-server with: ${model}`));
  if (args) console.log(chalk.grey(`Args: ${args}`));

  if (!(await isPortOpen(8081))) {
    console.log(chalk.yellow('Starting monitor.py...'));
    const monitor = spawn('python3', [MONITOR_PATH], { stdio: 'ignore', detached: true });
    monitor.unref();
    await new Promise(r => setTimeout(r, 1500));
  }

  const pollId = startTelemetry(5000);
  setUpdateCallback(renderTUI);
  resetParser();
  // Extract ctx size from args
  const ctxMatch = args.match(/-c\s+(\d+)/);
  if (ctxMatch) setCtxSize(parseInt(ctxMatch[1], 10));
  renderTUI();

  const cmdArgs = ['-m', model, ...args.split(/\s+/).filter(Boolean)];
  const server = spawn(serverBinary, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(chalk.red(`Cannot find binary: ${serverBinary}`));
      console.error(chalk.grey('Provide the full path with -s, e.g. -s /path/to/llama-server'));
    }
    stopTelemetry(pollId);
    cleanupTUI();
    process.exit(1);
  });

  let serverKilled = false;
  server.stdout.on('data', d => { if (!serverKilled) { parseChunk(d); setUpdateCallback(renderTUI); } });
  server.stderr.on('data', d => { if (!serverKilled) parseChunk(d); });

  const doCleanup = () => {
    try { server.kill('SIGTERM'); } catch { /* ignore */ }
    stopTelemetry(pollId);
    cleanupTUI();
    process.exit(0);
  };
  const doKillServer = () => {
    serverKilled = true;
    server.kill('SIGTERM');
  };

  setupInput(doCleanup, doKillServer);
  process.on('SIGINT', doCleanup);
  process.on('SIGTERM', doCleanup);
  server.on('exit', (code) => { if (!serverKilled) console.log(chalk.yellow(`llama-server exited with code ${code}. Press q to exit.`)); });
}

program
  .command('run [profile-name]')
  .description('Start server & enter monitoring TUI')
  .option('-m, --model <path>', 'Model path (overrides profile)')
  .option('-a, --args <string>', 'Launch args (overrides profile)')
  .option('-s, --server-binary <path>', 'Path to llama-server binary')
  .action(async (profileName, opts) => {
    let config = {};
    if (profileName) {
      const profiles = await loadProfiles();
      if (!profiles[profileName]) return console.error(chalk.red(`Profile "${profileName}" not found`));
      config = profiles[profileName];
    }
    const model = opts.model || config.model;
    const args = opts.args || config.args || '';
    if (!model) return console.error(chalk.red('Model path required (-m or profile)'));
    const binary = opts.serverBinary || await getLlamaServerBinary();
    await doRun(model, args, binary);
  });

program
  .command('launch')
  .description('Interactive launcher: pick profile, model, args, then run')
  .option('-s, --server-binary <path>', 'Path to llama-server binary')
  .action(async (opts) => {
    if (!process.stdin.isTTY) return console.error(chalk.red('Requires a terminal'));
    const config = await launchMenu();
    cleanupMenu();
    if (!config) return console.log(chalk.yellow('Cancelled.'));
    const binary = opts.serverBinary || await getLlamaServerBinary();
    await doRun(config.model, config.args || '', binary);
  });

program.parse();
