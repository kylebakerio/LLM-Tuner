// Launch profiles are stored SERVER-SIDE (dashboard /api/profiles ->
// <dashboard data dir>/logs/profiles.json, schema v3) so the browser UI and
// this CLI share one set of saved configs. Every function takes an McClient.
//
// Server document shape:
//   { "version": 3, "profiles": { "<name>": { config: {...launchConfig fields},
//     savedAt: <ms>, lastLoadedAt: <ms|null> } } }
//
// These functions speak the CLI's old contract -- listProfiles() returns a
// name -> config map, saveProfile(name, cfg) stores the launch-config object
// -- so Launch mode's code is unchanged. (The CLI's old
// ~/.llama-cli/profiles.json was imported by the server at first boot; it is
// no longer written.)

import { sortProfileEntries } from './launchconfig.js';

function unwrap(client, err) {
  // fetch rejects with an opaque TypeError when the server is unreachable --
  // say what's actually wrong, since profiles now live on the dashboard.
  if (err && /fetch failed|ECONNREFUSED|timeout|AbortError/i.test(err.message || '')) {
    return new Error(`can't reach the dashboard at ${client.baseUrl} \u2014 profiles are stored server-side`);
  }
  // A dashboard running pre-profiles code 404s the endpoint -- point at the
  // fix instead of a bare HTTP 404.
  if (err && /\/api\/profiles.*HTTP 404/.test(err.message || '')) {
    return new Error('this dashboard is running old code without shared profiles \u2014 restart it (pm2 restart dashboard)');
  }
  return err;
}

async function call(client, fn) {
  try {
    return await fn();
  } catch (err) {
    throw unwrap(client, err);
  }
}

export function loadProfiles(client) {
  return call(client, async () => {
    const doc = await client.getJson('/api/profiles');
    if (doc && typeof doc.profiles === 'object' && doc.profiles) return doc;
    return { version: 3, profiles: {} };
  });
}

// `lastLoadedAt` (optional) carries a profile's "last used" stamp along when
// it is saved under another name (rename); without it the server keeps the
// stamp an existing profile of that name already has.
export async function saveProfile(client, name, cfg, { lastLoadedAt } = {}) {
  if (!name || !String(name).trim()) throw new Error('Profile name is required');
  if (!cfg || typeof cfg !== 'object') throw new Error('Nothing to save');
  // Never persist the web's rawCommand from the CLI: /api/start runs a
  // non-empty rawCommand VERBATIM, so a stale one would silently override
  // every structured field the user edited here.
  const { rawCommand, ...config } = cfg;
  return call(client, async () => {
    await client.postJson('/api/profiles', {
      name: String(name).trim(),
      config,
      ...(lastLoadedAt ? { lastLoadedAt } : {}),
    });
    return config;
  });
}

export async function deleteProfile(client, name) {
  const key = String(name).trim();
  if (!key) throw new Error('Profile name is required');
  return call(client, () => client.deleteJson(`/api/profiles/${encodeURIComponent(key)}`));
}

export function listProfiles(client) {
  return call(client, async () => {
    const doc = await loadProfiles(client);
    // name -> config (the v2 contract the rest of the CLI expects)
    return Object.fromEntries(
      Object.entries(doc.profiles).map(([n, e]) => [n, e && e.config ? e.config : e]),
    );
  });
}

// [{ name, config, savedAt, lastLoadedAt }], most-recently-used first (the
// Launch picker and `profile list` order, same as the web dropdown).
export function listProfileEntries(client) {
  return call(client, async () => sortProfileEntries((await loadProfiles(client)).profiles));
}

// The profile list with what the server says about this machine:
//   { entries, availability, topology }
// `entries` as listProfileEntries(); `availability` is { name: { status,
// reason, placement } } -- can each profile run here -- and `topology` the
// machine's cards and workers. Both are null from a server that sends
// neither, and every profile is then treated as ready.
export function listProfileState(client) {
  return call(client, async () => {
    const doc = await loadProfiles(client);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
    return { entries: sortProfileEntries(doc.profiles), availability: obj(doc.availability), topology: obj(doc.topology) };
  });
}

// Record "used now" so the shared profile list (web + CLI) can sort by
// most-recently-used. Load-mark only: no config, no model-path revalidation.
// Fire-and-forget at call sites -- a failed mark must never block loading.
export function markProfileLoaded(client, name) {
  return call(client, () => client.postJson('/api/profiles', {
    name: String(name).trim(),
    lastLoadedAt: Date.now(),
  }));
}
