import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './config.js';

// Profile file schema v2:
//   { "version": 2, "profiles": { "<name>": { modelPath, build, ctx, ngl,
//     port, deviceA, deviceB, tensorSplit, argString, ...any launchConfig
//     field } } }
// v1 (legacy PoC): { "<name>": { model, args } } -- migrated on read.

function profilesFile() {
  return path.join(configDir(), 'profiles.json');
}

async function persist(doc) {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(profilesFile(), JSON.stringify(doc, null, 2));
}

function migrateV1(data) {
  const profiles = {};
  for (const [name, p] of Object.entries(data)) {
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      profiles[name] = {
        modelPath: p.model || '',
        argString: p.args || '',
      };
    }
  }
  return { version: 2, profiles };
}

export async function loadProfiles() {
  try {
    const data = JSON.parse(await fs.readFile(profilesFile(), 'utf-8'));
    if (data && data.version === 2 && data.profiles && typeof data.profiles === 'object') {
      return { version: 2, profiles: data.profiles };
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return migrateV1(data);
    }
  } catch {
    // missing or corrupt file -> empty
  }
  return { version: 2, profiles: {} };
}

export async function saveProfile(name, cfg) {
  if (!name || !String(name).trim()) throw new Error('Profile name is required');
  const clean = { ...cfg };
  if (clean.modelPath) {
    const resolved = path.resolve(clean.modelPath);
    try {
      await fs.access(resolved);
    } catch {
      throw new Error(`Model path not found: ${clean.modelPath}`);
    }
    clean.modelPath = resolved;
  }
  const doc = await loadProfiles();
  doc.profiles[String(name).trim()] = clean;
  await persist(doc);
  return clean;
}

export async function deleteProfile(name) {
  const doc = await loadProfiles();
  const key = String(name).trim();
  if (!doc.profiles[key]) throw new Error(`Profile "${key}" not found`);
  delete doc.profiles[key];
  await persist(doc);
}

export async function listProfiles() {
  return (await loadProfiles()).profiles;
}
