// The planner side of "never blend different configs" (2026-10-15): the Auto queue's thinking-off config is its own
// catalog row, and a config's "already ran" set is its own harness's groups only (ui/autoqueue/derive.js groupMatches).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'idc-'));
process.env.AUTOQUEUE_SETTINGS = path.join(TMP, 'autoqueue.json');
process.env.AUTOQUEUE_BATCHES = path.join(TMP, 'autoqueue-batches.json');
const AQ = require('../lib/autoqueue.js');
let uiDir = null;
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true }); });
async function ui(rel) {
    if (!uiDir) {
        uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-idc-'));
        fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(uiDir, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({ type: 'module' }));
    }
    return import(`file://${path.join(uiDir, 'ui', rel)}`);
}

test('autoqueue: a thinking-off config is the ~nothink row -- old saved settings (match: runnerModelIncludes) are read that way', () => {
    const d = AQ.DEFAULT_MODELS.find((m) => m.id === 'q4-nothink');
    assert.strictEqual(d.catalogKey, 'local:qwen3.8-27b:q4-k-xl~nothink');
    assert.ok(!AQ.DEFAULT_MODELS.find((m) => m.id === 'q4').match, 'the plain config needs no runner-model filter');
    fs.writeFileSync(process.env.AUTOQUEUE_SETTINGS, JSON.stringify({ models: [
        { id: 'q4', catalogKey: 'local:qwen3.8-27b:q4-k-xl', match: { runnerModelExcludes: 'nothink' } },
        { id: 'q4-nothink', catalogKey: 'local:qwen3.8-27b:q4-k-xl', match: { runnerModelIncludes: 'nothink' } },
        { id: 'mine-off', catalogKey: 'local:x:q4-k-m', cmd: '$STOCK -m /m/x.gguf --reasoning off', opencodeModel: 'x' },
        { id: 'cloud', catalogKey: 'cloud:anthropic:claude-haiku-4-5@low/solo', match: { runnerModelIncludes: 'haiku' } },
    ] }));
    const s = AQ.loadSettings();
    const by = Object.fromEntries(s.models.map((m) => [m.id, m]));
    assert.strictEqual(by.q4.catalogKey, 'local:qwen3.8-27b:q4-k-xl'); assert.ok(!by.q4.match);
    assert.strictEqual(by['q4-nothink'].catalogKey, 'local:qwen3.8-27b:q4-k-xl~nothink'); assert.ok(!by['q4-nothink'].match);
    assert.strictEqual(by['mine-off'].catalogKey, 'local:x:q4-k-m~nothink', 'a launch with --reasoning off is the thinking-off row');
    assert.deepStrictEqual(by.cloud.match, { runnerModelIncludes: 'haiku' }, 'other match rules are kept');
});

test('derive.groupMatches: another prompt variant, runner or harness mode of the same row is another config; the prompt level is not', async () => {
    const { groupMatches } = await ui('autoqueue/derive.js');
    const g = (c) => ({ m: { key: 'local:qwen3.8-27b:q4-k-xl' }, c: { runner: 'opencode', prompt_level: 'L2', harness_mode: 'agentic', ...c } });
    const spec = { catalogKey: 'local:qwen3.8-27b:q4-k-xl' };
    assert.ok(groupMatches(g({}), spec));
    assert.ok(groupMatches(g({ prompt_level: null, runner: null, harness_mode: null }), spec), 'unrecorded = the defaults (L2, opencode, agentic)');
    for (const c of [{ prompt_level: 'L2+review' }, { prompt_level: 'L2+careful-tone' }, { runner: 'pi' }, { harness_mode: 'oneshot' }])
        assert.ok(!groupMatches(g(c), spec), JSON.stringify(c));
    // 2026-10-17: a row's groups hold both levels' problems (T, T@L3); an L3 config matches the same groups and reads its
    // own level's problems from them (derive.js levelTasks). A variant is still another config at either level.
    assert.ok(groupMatches(g({}), { ...spec, promptLevel: 'L3' }), 'an L3 config matches its row\'s groups');
    assert.ok(!groupMatches(g({ prompt_level: 'L2+review' }), { ...spec, promptLevel: 'L3' }), 'a variant group is not the L3 config\'s');
    const cloud = { m: { key: 'cloud:anthropic:claude-haiku-4-5@low/solo' }, c: { runner: 'claude', prompt_level: 'L2', runnerModel: 'claude-haiku-4-5' } };
    assert.ok(groupMatches(cloud, { catalogKey: 'cloud:anthropic:claude-haiku-4-5@low/solo', lane: 'cloud', runner: 'claude' }));
    assert.ok(!groupMatches(g({}), { catalogKey: 'local:qwen3.8-27b:q4-k-xl~nothink' }), 'thinking off is another row');
});
