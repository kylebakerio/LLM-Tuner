import { test } from 'node:test';
import assert from 'node:assert/strict';

// Profiles now live SERVER-SIDE (shared with the web dashboard) -- these
// tests exercise the client against an in-memory mock of the
// /api/profiles contract (GET doc, POST upsert, DELETE by name).

function mockClient(initial = {}) {
  const state = { version: 3, profiles: initial };
  return {
    baseUrl: 'http://test',
    state,
    async getJson(p) {
      if (p === '/api/profiles') return state;
      throw new Error(`404 ${p}`);
    },
    async postJson(p, body) {
      if (p !== '/api/profiles') throw new Error(`405 ${p}`);
      const name = String((body && body.name) || '').trim();
      if (!name) throw new Error('Profile name must be 1-80 characters');
      state.profiles[name] = {
        config: (body && body.config) || {},
        savedAt: Date.now(),
        lastLoadedAt: (body && body.lastLoadedAt) || null,
      };
      return { ok: true, name };
    },
    async deleteJson(p) {
      const name = decodeURIComponent(p.slice('/api/profiles/'.length));
      if (!state.profiles[name]) throw new Error(`Profile "${name}" not found`);
      delete state.profiles[name];
      return { ok: true, name };
    },
  };
}

test('profiles: save/list/delete round-trip via the server API', async () => {
  const { saveProfile, listProfiles, deleteProfile } = await import('../src/profiles.js');
  const client = mockClient();

  await saveProfile(client, 'p1', { modelPath: '/x/m.gguf', ctx: 8192, build: 'vulkan' });
  let list = await listProfiles(client);
  assert.equal(Object.keys(list).length, 1);
  // listProfiles unwraps the server entry -> the name->config map the TUI expects
  assert.equal(list.p1.ctx, 8192);
  assert.equal(list.p1.modelPath, '/x/m.gguf');

  // overwrite is an upsert, not a duplicate
  await saveProfile(client, 'p1', { modelPath: '/x/m.gguf', ctx: 16384 });
  assert.equal(Object.keys(await listProfiles(client)).length, 1);
  assert.equal((await listProfiles(client)).p1.ctx, 16384);

  await deleteProfile(client, 'p1');
  assert.deepEqual(await listProfiles(client), {});
  await assert.rejects(() => deleteProfile(client, 'p1'), /not found/i);
});

test('profiles: web-shaped entries (config wrapper) unwrap to config', async () => {
  const { listProfiles } = await import('../src/profiles.js');
  const client = mockClient({
    webprof: {
      config: { modelPath: '/w/m.gguf', rawCommand: 'llama-server ...', fa: true },
      savedAt: 123, lastLoadedAt: 456,
    },
  });
  const list = await listProfiles(client);
  assert.equal(list.webprof.modelPath, '/w/m.gguf');
  assert.equal(list.webprof.rawCommand, 'llama-server ...');
  assert.equal(list.webprof.fa, true);
});

test('profiles: saveProfile never persists rawCommand (duplicating a web profile included)', async () => {
  const { saveProfile, listProfiles } = await import('../src/profiles.js');
  const client = mockClient({
    webprof: { config: { modelPath: '/w/m.gguf', rawCommand: '/x/llama-server -m /w/other.gguf', rpcTarget: 'laptop', transport: 'TB4' }, savedAt: 1 },
  });
  const cfg = (await listProfiles(client)).webprof;
  await saveProfile(client, 'copy', cfg);
  const stored = client.state.profiles.copy.config;
  assert.equal('rawCommand' in stored, false);
  assert.equal(stored.rpcTarget, 'laptop', 'RPC fields round-trip with the web');
  assert.equal(stored.transport, 'TB4');
});

test('profiles: listProfileEntries sorts by lastLoadedAt/savedAt, newest first', async () => {
  const { listProfileEntries } = await import('../src/profiles.js');
  const client = mockClient({
    a: { config: { modelPath: '/a' }, savedAt: 10, lastLoadedAt: null },
    b: { config: { modelPath: '/b', rpcTarget: 'laptop' }, savedAt: 5, lastLoadedAt: 30 },
    c: { config: { modelPath: '/c' }, savedAt: 20, lastLoadedAt: null },
  });
  const entries = await listProfileEntries(client);
  assert.deepEqual(entries.map((e) => e.name), ['b', 'c', 'a']);
  assert.equal(entries[0].config.rpcTarget, 'laptop');
});

test('profiles: client-side validation and server errors surface cleanly', async () => {
  const { saveProfile, deleteProfile } = await import('../src/profiles.js');
  const client = mockClient();

  await assert.rejects(() => saveProfile(client, '  ', { modelPath: '/x' }), /name is required/i);
  await assert.rejects(() => saveProfile(client, 'p', null), /nothing to save/i);

  // server-side rejection (e.g. model path missing on the dashboard host)
  const strict = mockClient();
  strict.postJson = async () => { throw new Error('Model path not found: /nope/missing.gguf'); };
  await assert.rejects(() => saveProfile(strict, 'p2', { modelPath: '/nope/missing.gguf' }), /Model path not found/);

  // unreachable server -> actionable message, not an opaque fetch TypeError
  const dead = {
    baseUrl: 'http://nowhere:3000',
    getJson: async () => { throw new Error('fetch failed'); },
  };
  const { listProfiles } = await import('../src/profiles.js');
  await assert.rejects(() => listProfiles(dead), /can't reach the dashboard at http:\/\/nowhere:3000/);
});
