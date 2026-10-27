// --- ONE VERSION OF THE SHARED CODE (2026-10-09, Kyle: "ai and lab should not be able to get out of sync") ---
// The lab dashboard (server4.js) and the public site (public/server.js) are two Node processes that each `require`
// the same lib/ modules ONCE, at their own start. Restarting only the dashboard after a change to lib/models.js left
// the public site building its catalog with the old row rules for as long as it stayed up (thinking-off, advisor,
// effort and helper rows, 10-08/09).
// The dashboard is the source of truth: at start it writes the stamp of the lib/ code it loaded to
// logs/lib-stamp.json. The public server follows ON USE, with no timer and no restart: whenever its API is asked
// for data it compares that stamp with its own (public/server.js ensureFresh); when they differ and the files on
// disk are the dashboard's code, it loads those modules again in place and rebuilds its data. If the disk has moved
// on but the dashboard has not been restarted yet, nothing happens: the public site never runs code the lab is not
// running.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIB = __dirname;
const STAMP_FILE = path.join(LIB, '..', 'logs', 'lib-stamp.json');

/** sha1 over every lib/*.js file's name and bytes (backups excluded). */
function diskStamp(dir = LIB) {
    const h = crypto.createHash('sha1');
    for (const f of fs.readdirSync(dir).filter((n) => /\.js$/.test(n)).sort()) {
        h.update(f + '\0'); h.update(fs.readFileSync(path.join(dir, f))); h.update('\0');
    }
    return h.digest('hex').slice(0, 16);
}

const LOADED = diskStamp();   // what THIS process is running: taken when the module is first required

function writeStamp(file = STAMP_FILE) {
    const rec = { stamp: LOADED, pid: process.pid, at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(rec)); fs.renameSync(file + '.tmp', file);
    return rec;
}

function readStamp(file = STAMP_FILE) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).stamp || null; } catch { return null; }
}

/** For a follower process: true when it should load the dashboard's code. */
function shouldFollow({ loaded = LOADED, source = readStamp(), disk = null } = {}) {
    if (!source || source === loaded) return false;
    return (disk || diskStamp()) === source;
}

module.exports = { diskStamp, writeStamp, readStamp, shouldFollow, LOADED, STAMP_FILE };
