const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const chalk = require('chalk').default;
const { loadProfiles, listProfiles } = require('./profiles');

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
  } catch { /* skip */ }
  return results;
}

async function scanModels() {
  const dirs = [
    path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
    path.join(process.cwd(), 'models'),
    path.join(os.homedir(), 'llama.cpp', 'models')
  ];
  let results = [];
  for (const dir of dirs) results = results.concat(await scanDirRecursive(dir));
  return results;
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
  });
}

function renderMenu(items, selected, title) {
  const { cursorTo, eraseDown } = require('ansi-escapes').default;
  process.stdout.write(cursorTo(0, 0) + eraseDown);
  console.log(chalk.bold.bgBlue(' Llama CLI ') + '\n');
  console.log(chalk.cyan(title) + '\n');
  items.forEach((item, i) => {
    const arrow = i === selected ? chalk.green('>> ') : '   ';
    if (i === selected) console.log(arrow + chalk.bold.yellow(item.label));
    else console.log(arrow + item.label);
  });
  console.log('');
  console.log(chalk.dim('Enter: Select  |  q: Cancel'));
  process.stdout.write(cursorTo(0, process.stdout.rows - 2));
}

async function selectItem(items, title) {
  if (!items.length) return null;
  let selected = 0;
  return new Promise(resolve => {
    const render = () => renderMenu(items, selected, title);
    render();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.on('line', line => {
      if (line === '' || line === '\r') { rl.close(); resolve(items[selected]); return; }
      const idx = parseInt(line, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= items.length) { rl.close(); resolve(items[idx - 1]); return; }
      if (line.toLowerCase() === 'q') { rl.close(); resolve(null); return; }
    });

    process.stdin.on('keypress', (str, key) => {
      if (key.name === 'up') { selected = (selected - 1 + items.length) % items.length; render(); }
      if (key.name === 'down') { selected = (selected + 1) % items.length; render(); }
      if (key.name === 'return') { rl.write('\n'); }
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) { rl.close(); resolve(null); }
    });
  });
}

async function profileMenu() {
  const profiles = await loadProfiles();
  const names = Object.keys(profiles);
  if (!names.length) {
    console.log(chalk.yellow('No profiles found. Use: llama-cli profile save <name> -m <model>'));
    return null;
  }
  const items = names.map(name => ({
    label: `${name}  ${chalk.grey('(' + path.basename(profiles[name].model || '?') + ')')}`,
    profile: profiles[name],
    name
  }));
  const chosen = await selectItem(items, 'Select Profile');
  return chosen ? chosen.profile : null;
}

async function modelMenu() {
  console.log(chalk.grey('Scanning models...'));
  const models = await scanModels();
  if (!models.length) {
    console.log(chalk.yellow('No models found.'));
    return null;
  }
  const items = models.map(m => ({
    label: `${m.name}  ${chalk.grey(m.size + '  ' + m.path)}`,
    model: m
  }));
  const chosen = await selectItem(items, 'Select Model (type number or press Enter)');
  return chosen ? chosen.model : null;
}

async function launch() {
  let config = null;

  console.log(chalk.dim('--- Launch Mode ---'));
  console.log('  1) Load saved profile');
  console.log('  2) Pick model + args manually');
  const mode = await ask(chalk.blue('\nChoice (1/2): '));

  if (mode === '1') {
    config = await profileMenu();
    if (!config) return null;
  } else {
    const model = await modelMenu();
    if (!model) return null;
    config = { model: model.path, args: '' };
  }

  const currentArgs = config.args || '';
  const newArgs = await ask(chalk.blue(`Args [${currentArgs}]: `));
  config.args = newArgs || currentArgs;

  return config;
}

function cleanup() {
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* */ }
  }
}

module.exports = { launch, cleanup };
