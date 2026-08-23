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

export async function saveProfile(client, name, cfg) {
  if (!name || !String(name).trim()) throw new Error('Profile name is required');
  if (!cfg || typeof cfg !== 'object') throw new Error('Nothing to save');
  return call(client, async () => {
    await client.postJson('/api/profiles', { name: String(name).trim(), config: cfg });
    return cfg;
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

// Record "used now" so the shared profile list (web + CLI) can sort by
// most-recently-used. Load-mark only: no config, no model-path revalidation.
// Fire-and-forget at call sites -- a failed mark must never block loading.
export function markProfileLoaded(client, name) {
  return call(client, () => client.postJson('/api/profiles', {
    name: String(name).trim(),
    lastLoadedAt: Date.now(),
  }));
}
