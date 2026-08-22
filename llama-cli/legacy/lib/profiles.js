const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const PROFILES_DIR = path.join(os.homedir(), '.llama-cli');
const PROFILES_FILE = path.join(PROFILES_DIR, 'profiles.json');

async function ensureDir() {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
}

async function loadProfiles() {
  await ensureDir();
  try {
    const data = await fs.readFile(PROFILES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveProfile(name, config) {
  await ensureDir();
  const profiles = await loadProfiles();

  if (config.model) {
    const resolved = path.resolve(config.model);
    try {
      await fs.access(resolved);
      config.model = resolved;
    } catch {
      throw new Error(`Model path not found: ${config.model}`);
    }
  }

  profiles[name] = config;
  await fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  console.log(`✅ Saved profile "${name}"`);
}

async function deleteProfile(name) {
  await ensureDir();
  const profiles = await loadProfiles();
  if (!profiles[name]) throw new Error(`Profile "${name}" not found`);
  delete profiles[name];
  await fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  console.log(`🗑️  Deleted profile "${name}"`);
}

async function listProfiles() {
  const profiles = await loadProfiles();
  const keys = Object.keys(profiles);
  if (keys.length === 0) {
    console.log('No profiles found. Use `llama-cli profile save <name> -m <model>` to create one.');
    return;
  }
  const table = keys.map(name => ({
    name,
    model: profiles[name].model ? path.basename(profiles[name].model) : '-',
    args: profiles[name].args || '-'
  }));
  console.table(table);
}

module.exports = { loadProfiles, saveProfile, deleteProfile, listProfiles };
