'use strict';
// What asks the dashboard for what, and how often (2026-10-22, Kyle: "cloudflare says lab.kylebaker.io got 65.1k
// requests in the last 24 hours ... that's an internal site ... sounds like some terrible inefficiency"). Counted in
// memory since the last restart, read at GET /api/debug/requests (behind the tunnel gate like everything else):
//   - by path pattern (no query string; ids and the /v/<hash>/ prefix folded, so the list stays short);
//   - by way in: `tunnel` when the Host header names something other than this machine (cloudflared passes the public
//     hostname through; those are the requests Cloudflare counts), `local` for localhost / an IP address;
//   - by credentials as sent (not as checked): bearer, cookie, none -- with the status codes, enough to see a client
//     that pays the Bearer check on every request, or one that keeps getting 401s;
//   - by user agent (the top ones), and per minute over the last hour.
// Counted at the very top of the request handler, before the gate, so the gate's own 401s are in it too.

const PATH_CAP = 300, UA_CAP = 60, HOST_CAP = 20, MINUTES = 60, RECENT_MINUTES = 10;
const OTHER = '(other)';

/** '/v/0123abcd/ui/models/index.js?x' -> '/v/<hash>/ui/*'; '/api/queue/1234/note' -> '/api/queue/:n/note'. */
function pathPattern(url) {
    const p = String(url || '/').split('?')[0] || '/';
    const v = /^\/v\/[0-9a-f]{6,40}(\/.*)?$/.exec(p);
    if (v) return '/v/<hash>' + (/^\/ui\//.test(v[1] || '') ? '/ui/*' : /^\/vendor\//.test(v[1] || '') ? '/vendor/*' : '/*');
    if (/^\/ui\/[\w-]+\/[\w.-]+$/.test(p)) return '/ui/*';
    if (/^\/vendor\//.test(p)) return '/vendor/*';
    if (/^\/api\/profiles\/./.test(p)) return '/api/profiles/:name';
    return p.split('/').map((s) => (/^\d+$/.test(s) ? ':n' : /^[0-9a-f]{12,}$/i.test(s) ? ':id' : s.length > 60 ? ':long' : s)).join('/');
}

/** The Host header's name ('ai.kylebaker.io', 'localhost', '127.0.0.1') and whether that is the tunnel. */
function wayIn(host) {
    const h = String(host || '').trim().toLowerCase();
    const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '');
    // a bare machine name, an address, or a LAN / tailnet name: nothing Cloudflare carried
    const local = !name || !name.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith('[') || /\.(local|lan|home\.arpa|ts\.net)$/.test(name);
    return { name: name || '(none)', via: local ? 'local' : 'tunnel' };
}

/** How the request presents itself (not whether that is valid: the gate decides that). */
function authKind(headers) {
    const a = headers && headers['authorization'];
    if (typeof a === 'string' && a.startsWith('Bearer ')) return 'bearer';
    const c = headers && headers['cookie'];
    if (typeof c === 'string' && /(?:^|;\s*)mc_session=/.test(c)) return 'cookie';
    return 'none';
}

/** Add one to `map[key]`; a new key past `cap` counts under '(other)'. */
function bump(map, key, cap, by = 1) {
    const k = map.has(key) || map.size < cap ? key : OTHER;
    map.set(k, (map.get(k) || 0) + by);
}

function createTally({ now = () => Date.now() } = {}) {
    const since = now();
    let total = 0;
    const paths = new Map();       // pattern -> { n, tunnel, local }
    const agents = new Map(), hosts = new Map(), auth = new Map(), status = new Map(), via = new Map();
    const minutes = [];            // [{ at, n, tunnel, local, paths: Map }] oldest first, at most MINUTES

    function minuteNow(t) {
        const at = Math.floor(t / 60000) * 60000;
        let m = minutes[minutes.length - 1];
        if (!m || m.at !== at) {
            m = { at, n: 0, tunnel: 0, local: 0, paths: new Map() };
            minutes.push(m);
            while (minutes.length > MINUTES || (minutes.length && minutes[0].at <= at - MINUTES * 60000)) minutes.shift();
        }
        return m;
    }

    /** Count one request; its status is added when the response finishes (an SSE stream: when it closes). */
    function count(req, res) {
        const t = now();
        const pattern = pathPattern(req.url), w = wayIn(req.headers && req.headers.host);
        total++;
        let e = paths.get(pattern);
        if (!e) {
            if (paths.size >= PATH_CAP) e = paths.get(OTHER) || paths.set(OTHER, { n: 0, tunnel: 0, local: 0 }).get(OTHER);
            else paths.set(pattern, (e = { n: 0, tunnel: 0, local: 0 }));
        }
        e.n++; e[w.via]++;
        bump(via, w.via, 2);
        bump(hosts, w.name, HOST_CAP);
        bump(auth, authKind(req.headers), 3);
        bump(agents, String((req.headers && req.headers['user-agent']) || '(none)').slice(0, 160), UA_CAP);
        const m = minuteNow(t);
        m.n++; m[w.via]++;
        bump(m.paths, pattern, PATH_CAP);
        if (res && typeof res.once === 'function') res.once('finish', () => bump(status, String(res.statusCode), 40));
    }

    function snapshot() {
        const t = now();
        minuteNow(t);   // rolls the window forward on a quiet server
        const up = Math.max(1 / 60, (t - since) / 60000);
        const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
        const per = (n, min) => Math.round((n / min) * 10) / 10;
        // the last RECENT_MINUTES whole minutes since the start (the current one is still filling; a quiet minute has
        // no bucket but still counts as a minute)
        const cur = Math.floor(t / 60000) * 60000;
        const from = Math.max(cur - RECENT_MINUTES * 60000, Math.floor(since / 60000) * 60000);
        const recent = minutes.filter((m) => m.at >= from && m.at < cur);
        const recentPaths = new Map();
        for (const m of recent) for (const [k, n] of m.paths) bump(recentPaths, k, PATH_CAP, n);
        const recentN = recent.reduce((a, m) => a + m.n, 0);
        const spanMin = (cur - from) / 60000, recentMin = Math.max(1, spanMin);
        return {
            since, at: t, uptimeMin: Math.round(up * 10) / 10, total, perMin: per(total, up),
            via: Object.fromEntries(via), hosts: Object.fromEntries(sorted(hosts)), auth: Object.fromEntries(auth),
            status: Object.fromEntries(sorted(status)),
            recent: { minutes: spanMin, n: recentN, perMin: per(recentN, recentMin),
                byPath: sorted(recentPaths).map(([path, n]) => ({ path, n, perMin: per(n, recentMin) })) },
            byPath: [...paths.entries()].sort((a, b) => b[1].n - a[1].n).map(([path, x]) => ({ path, n: x.n, perMin: per(x.n, up), tunnel: x.tunnel, local: x.local })),
            topAgents: sorted(agents).slice(0, 10).map(([ua, n]) => ({ ua, n })),
            lastMinutes: minutes.map((m) => ({ at: m.at, n: m.n, tunnel: m.tunnel, local: m.local })),
        };
    }

    return { count, snapshot };
}

module.exports = { createTally, pathPattern, wayIn, authKind };
