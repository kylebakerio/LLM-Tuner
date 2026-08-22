import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Paths are computed at call time (not module load) so tests can point
// HOME at a temp dir.
export function configDir() {
  return path.join(os.homedir(), '.llama-cli');
}

const DEFAULTS = {
  server: 'http://localhost:3000',
  telemetryMs: 1000,
};

export async function loadConfig() {
  try {
    const raw = await fs.readFile(path.join(configDir(), 'config.json'), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(path.join(configDir(), 'config.json'), JSON.stringify(next, null, 2));
  return next;
}
