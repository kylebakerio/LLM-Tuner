const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cs = require('../lib/codestamp');

test('codestamp: the stamp follows the bytes of lib/*.js and ignores backups', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    fs.writeFileSync(path.join(d, 'a.js'), 'x'); fs.writeFileSync(path.join(d, 'a.js.bak-1'), 'y');
    const s1 = cs.diskStamp(d);
    fs.writeFileSync(path.join(d, 'a.js.bak-2'), 'z'); assert.strictEqual(cs.diskStamp(d), s1);
    fs.writeFileSync(path.join(d, 'a.js'), 'x2'); assert.notStrictEqual(cs.diskStamp(d), s1);
    fs.rmSync(d, { recursive: true });
});

test('codestamp: a follower restarts only onto the code the dashboard is running', () => {
    assert.strictEqual(cs.shouldFollow({ loaded: 'A', source: 'A', disk: 'A' }), false, 'same code: stay up');
    assert.strictEqual(cs.shouldFollow({ loaded: 'A', source: 'B', disk: 'B' }), true, 'dashboard restarted onto new code: follow');
    assert.strictEqual(cs.shouldFollow({ loaded: 'A', source: 'B', disk: 'C' }), false, 'disk moved past the dashboard: wait for the dashboard');
    assert.strictEqual(cs.shouldFollow({ loaded: 'A', source: null, disk: 'B' }), false, 'no dashboard stamp: stay up');
});
