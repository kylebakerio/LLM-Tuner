'use strict';
// The dashboard's own JS and CSS under /v/<hash>/..., cacheable for good and never stale (2026-10-06, Kyle: "it
// still seems unnecessary and surprising that the models page is a relatively heavy load"). Every page load used
// to download script.js, 28 ES modules and the vendor files again -- ~1.65 MB, uncompressed, `no-store` -- in a
// three-level import waterfall, because a cached script.js had once run old code against a fresh index.html.
//
// Why a versioned path and not ETag + `Cache-Control: no-cache`: revalidation is only as good as every cache on
// the way, and this dashboard is also reached through Cloudflare (ai.kylebaker.io; lab.* until 2026-10-22), which
// rewrote the public site's no-cache into a 31-day browser cache (public/server.js). A URL that changes cannot be
// served stale by anyone. public/server.js does the same for the public site; ES-module imports are relative, so one directory
// prefix covers every module a page pulls in.
//
// Why it cannot be stale: <hash> is a hash of the BYTES of every file in the set, and a /v/<hash>/ request is
// answered as immutable only while <hash> is the current one -- from the same in-memory bytes that were hashed,
// not from a second read of the disk. So a URL under /v/<hash>/ has exactly one possible body. Any edit to any
// file gives a new hash, and index.html (never cached) names the new URLs on the next load. A request under an
// old hash (a page opened before the edit importing a module late) gets the current file, uncached.
//
// The set: script.js, vendor/*.js|css, ui/<dir>/*.js|css. Each call stats them (~75 files, well under 1 ms) and
// re-reads only what changed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const TYPES = { '.js': 'application/javascript', '.css': 'text/css' };
const IMMUTABLE = 'private, max-age=31536000, immutable';   // private: behind the tunnel's password gate, so never in a shared (edge) cache

function createAssets(root, fsi = fs) {
    const files = new Map();   // '/ui/models/index.js' -> { mtimeMs, size, sha, body, type, enc: {br, gzip} promises }
    let last = { key: null, hash: null };

    const listDir = (rel) => {
        try { return fsi.readdirSync(path.join(root, rel)).filter((f) => /^[\w.-]+\.(js|css)$/.test(f)).map((f) => `/${rel}/${f}`); } catch { return []; }
    };
    function names() {
        const out = ['/script.js', ...listDir('vendor')];
        let dirs = [];
        try { dirs = fsi.readdirSync(path.join(root, 'ui'), { withFileTypes: true }).filter((d) => d.isDirectory() && /^[\w-]+$/.test(d.name)).map((d) => d.name); } catch { /* no ui/ */ }
        for (const d of dirs) out.push(...listDir(`ui/${d}`));
        return out.sort();
    }

    /** The current set: { hash, has(p), get(p) }. Reads a file only when its mtime or size changed. */
    function snapshot() {
        const seen = new Set();
        const parts = [];
        for (const p of names()) {
            const file = path.join(root, p);
            let st; try { st = fsi.statSync(file); } catch { continue; }
            let e = files.get(p);
            if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
                let body; try { body = fsi.readFileSync(file); } catch { continue; }
                e = { mtimeMs: st.mtimeMs, size: st.size, body, sha: crypto.createHash('sha1').update(body).digest('hex'), type: TYPES[path.extname(p)], enc: {} };
                files.set(p, e);
            }
            seen.add(p);
            parts.push(`${p}:${e.sha}`);
        }
        for (const p of [...files.keys()]) if (!seen.has(p)) files.delete(p);
        const key = parts.join('|');
        if (key !== last.key) last = { key, hash: crypto.createHash('sha1').update(key).digest('hex').slice(0, 12) };
        return { hash: last.hash, has: (p) => files.has(p), get: (p) => files.get(p) || null };
    }

    /** The file for GET /v/<hash><p>, or null when <hash> is not the current one (or the file is not in the set). */
    function versioned(hash, p) {
        const s = snapshot();
        return s.hash === hash ? s.get(p) : null;
    }

    /** `entry`'s body in a content encoding ('br' | 'gzip'), compressed once per version of the file. */
    function encoded(entry, enc) {
        if (!entry.enc[enc]) {
            entry.enc[enc] = new Promise((resolve, reject) => {
                const done = (err, out) => (err ? reject(err) : resolve(out));
                if (enc === 'br') zlib.brotliCompress(entry.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 7, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length } }, done);
                else zlib.gzip(entry.body, { level: 7 }, done);
            });
            entry.enc[enc].catch(() => { delete entry.enc[enc]; });
        }
        return entry.enc[enc];
    }

    /** index.html with every local `./x.js|css` it names moved under /v/<hash>/ (files outside the set are left alone). */
    function versionHtml(html) {
        const s = snapshot();
        return String(html).replace(/(src|href)="\.\/([^"?]+\.(?:js|css))"/g, (full, attr, rel) => (s.has('/' + rel) ? `${attr}="/v/${s.hash}/${rel}"` : full));
    }

    return { snapshot, versioned, encoded, versionHtml };
}

module.exports = { createAssets, IMMUTABLE };
