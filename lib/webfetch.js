'use strict';
// --- WEB FETCH (backing for the chat's web_fetch tool) ---
// Downloads one page for the model and returns its readable text as markdown.
// Extraction is Mozilla Readability (Firefox Reader View's engine) over a
// linkedom DOM, then Turndown for HTML -> markdown; this module is the safety
// layer around them. The URL comes from the model and this server sits on the
// LAN (llama-server, the dashboard, RPC workers, the router), so every hop --
// redirects included -- must resolve to a public address, and each connection
// is pinned to the address that was checked, so DNS can't be switched between
// the check and the connect. Tested in test/webfetch.test.js.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_CHARS = 12000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

// Non-public IPv4 ranges: this host, private, CGNAT, loopback, link-local,
// IETF/benchmarking, multicast, reserved.
const V4_BLOCKED = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
    return ip.split('.').reduce((n, octet) => (n * 256) + Number(octet), 0);
}

function isPublicAddress(ip) {
    if (net.isIPv4(ip)) {
        const n = ipv4ToInt(ip);
        return !V4_BLOCKED.some(([base, len]) => {
            const mask = (0xFFFFFFFF << (32 - len)) >>> 0;
            return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
        });
    }
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPublicAddress(mapped[1]);
        if (v === '::' || v === '::1') return false;
        if (/^f[cd]/.test(v)) return false;     // fc00::/7 unique local
        if (/^fe[89ab]/.test(v)) return false;  // fe80::/10 link-local
        if (/^ff/.test(v)) return false;        // multicast
        return true;
    }
    return false;
}

// http(s).request `lookup` that refuses hostnames resolving to any
// non-public address. The socket connects to the address checked here.
function publicOnlyLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const bad = addresses.find((a) => !isPublicAddress(a.address));
        if (bad) return callback(new Error(`blocked: ${hostname} resolves to a non-public address (${bad.address})`));
        if (options && options.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
    });
}

function requestOnce(url, deadline) {
    return new Promise((resolve, reject) => {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        // IP literals never go through `lookup`, so check them here.
        if (net.isIP(host) && !isPublicAddress(host)) {
            reject(new Error(`blocked: ${host} is a non-public address`));
            return;
        }
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, {
            method: 'GET',
            lookup: publicOnlyLookup,
            timeout: Math.max(1, deadline - Date.now()),
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
            },
        }, resolve);
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end();
    });
}

// The (decompressed) body, stopping at MAX_BYTES or the deadline.
function readBody(res, deadline) {
    return new Promise((resolve, reject) => {
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
            : enc === 'deflate' ? res.pipe(zlib.createInflate())
            : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
            : res;
        const chunks = [];
        let size = 0;
        let clipped = false;
        const timer = setTimeout(() => { res.destroy(); reject(new Error('timed out')); }, Math.max(1, deadline - Date.now()));
        stream.on('data', (chunk) => {
            if (clipped) return;
            chunks.push(chunk);
            size += chunk.length;
            if (size >= MAX_BYTES) {
                clipped = true;
                res.destroy();
                clearTimeout(timer);
                resolve({ body: Buffer.concat(chunks).subarray(0, MAX_BYTES), clipped });
            }
        });
        stream.on('end', () => { clearTimeout(timer); if (!clipped) resolve({ body: Buffer.concat(chunks), clipped }); });
        stream.on('error', (err) => { clearTimeout(timer); if (!clipped) reject(err); });
    });
}

function decode(buf, charset) {
    try {
        return new TextDecoder(charset || 'utf-8').decode(buf);
    } catch {
        return new TextDecoder('utf-8').decode(buf);
    }
}

// Readable markdown for an HTML page: Readability's article when it finds
// one, else the whole body (search pages, app shells, listings).
function htmlToMarkdown(html) {
    const { parseHTML } = require('linkedom');
    const { Readability } = require('@mozilla/readability');
    const TurndownService = require('turndown');
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    // No markdown escaping: the model reads this text, nothing renders it, and
    // `UD-Q4\_K\_XL`-style backslashes are only noise.
    turndown.escape = (s) => s;
    // Images, media and links with no visible text (image links once the
    // images are gone, heading anchors like `[](#quick-start)`) would only
    // spend the character budget on urls.
    turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button', 'img', 'picture', 'video', 'audio']);
    turndown.addRule('emptyLink', {
        filter: (node) => node.nodeName === 'A' && !String(node.textContent || '').trim(),
        replacement: () => '',
    });
    const { document } = parseHTML(html);
    const title = (document.title || '').trim() || null;
    let article = null;
    try {
        article = new Readability(document).parse(); // mutates `document`
    } catch {
        article = null;
    }
    if (article && article.content && article.textContent && article.textContent.trim().length > 200) {
        return { title: (article.title || title || '').trim() || null, markdown: tidy(turndown.turndown(article.content)) };
    }
    const fresh = parseHTML(html).document;
    return { title, markdown: tidy(turndown.turndown(fresh.body ? fresh.body.innerHTML : html)) };
}

function tidy(markdown) {
    return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

function clip(content, maxChars) {
    const truncated = content.length > maxChars;
    return { content: truncated ? content.slice(0, maxChars) : content, truncated, chars: content.length };
}

// Fetch `rawUrl` and return { finalUrl, title, content, truncated, chars,
// downloadClipped }. Throws with a message fit for the model on anything it
// won't or can't read.
async function fetchPage(rawUrl, { maxChars = DEFAULT_MAX_CHARS } = {}) {
    let url;
    try {
        url = new URL(String(rawUrl || '').trim());
    } catch {
        throw new Error('invalid url');
    }
    const deadline = Date.now() + TIMEOUT_MS;
    for (let hop = 0; ; hop++) {
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported protocol ${url.protocol}`);
        if (url.username || url.password) throw new Error('urls with credentials are not fetched');
        const res = await requestOnce(url, deadline);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
            url = new URL(res.headers.location, url);
            continue;
        }
        if (res.statusCode >= 400) {
            res.resume();
            throw new Error(`HTTP ${res.statusCode}`);
        }
        const type = String(res.headers['content-type'] || '').toLowerCase();
        if (type && !/html|xml|^text\/|json/.test(type)) {
            res.resume();
            throw new Error(`unsupported content type ${type.split(';')[0]} (only web pages and text)`);
        }
        const { body, clipped } = await readBody(res, deadline);
        const text = decode(body, (type.match(/charset=([^;\s]+)/) || [])[1]);
        const isHtml = /html|xml/.test(type) || (!type && /^\s*</.test(text));
        const { title, markdown } = isHtml ? htmlToMarkdown(text) : { title: null, markdown: text.trim() };
        return { finalUrl: url.href, title, ...clip(markdown, maxChars), downloadClipped: clipped };
    }
}

module.exports = { DEFAULT_MAX_CHARS, isPublicAddress, htmlToMarkdown, fetchPage };
