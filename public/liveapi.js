// Cross-origin access to the public site's read-only JSON API (2026-10-06). See STATIC-ARCHITECTURE.md.
//
// The static build of the site is served from another origin (Netlify) and asks THIS machine for fresher data and
// live status while it is up. A browser only lets it read the answer if the answer names that origin. The API is
// public, read-only and cookie-less either way; this allow-list decides which web pages may embed it, nothing more.
//
// Default: no list, no headers, exactly the old behaviour. Configure with site.config.json
//   "corsOrigins": ["https://lab.kylebaker.io", "https://lab-kylebaker.pages.dev"]
// or the PUBLIC_CORS_ORIGINS environment variable (comma separated; it wins). Entries:
//   "https://lab.kylebaker.io"           an exact origin (the public site; ai.kylebaker.io until 2026-10-22)
//   "https://*--my-site.netlify.app"     one "*" = one run of [a-z0-9-] (Netlify deploy previews); never crosses a dot
//   "*"                                  any origin (the only choice that is safe behind a shared cache with several origins)
//
// Never sent: Access-Control-Allow-Credentials. No cookie or Authorization header is ever honoured cross-origin.

'use strict';

const ORIGIN_RE = /^https?:\/\/[a-z0-9.*-]+(?::\d{1,5})?$/i;

/** The configured list, cleaned: env string or config array -> valid entries only. */
function parseOrigins(envValue, configValue) {
    const raw = envValue != null && String(envValue).trim() !== '' ? String(envValue).split(',') : Array.isArray(configValue) ? configValue : [];
    const out = [];
    for (const x of raw) {
        const s = String(x || '').trim().replace(/\/+$/, '');
        if (s === '*' || (ORIGIN_RE.test(s) && (s.match(/\*/g) || []).length <= 1)) out.push(s);
    }
    return [...new Set(out)];
}

function originAllowed(origin, allow) {
    if (!origin) return false;
    for (const a of allow) {
        if (a === '*' || a === origin) return true;
        if (a.includes('*')) {
            const re = new RegExp('^' + a.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '[a-z0-9-]+') + '$', 'i');
            if (re.test(origin)) return true;
        }
    }
    return false;
}

/** Response headers for an /api/ request. `origin` is the request's Origin header (undefined for same-origin GETs).
 *  {} when the allow-list is empty: nothing changes for anyone. */
function corsHeaders(origin, allow) {
    if (!allow || !allow.length) return {};
    const base = { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' };
    if (allow.includes('*')) return { 'Access-Control-Allow-Origin': '*', ...base };
    // One exact origin: say so on every answer, so the answer is the same for every caller and a shared cache
    // (Cloudflare ignores Vary: Origin) can never hand a browser a copy without the header.
    if (allow.length === 1 && !allow[0].includes('*')) return { 'Access-Control-Allow-Origin': allow[0], ...base };
    // Several: echo the caller's origin when it is on the list, and tell caches the answer depends on it.
    return originAllowed(origin, allow) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', ...base } : { Vary: 'Origin' };
}

module.exports = { parseOrigins, originAllowed, corsHeaders };
