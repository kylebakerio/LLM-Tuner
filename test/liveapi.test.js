// Cross-origin access to the public JSON API (public/liveapi.js): off by default, an explicit allow-list, never credentials.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOrigins, originAllowed, corsHeaders } = require('../public/liveapi');

test('no list -> no headers at all (the server behaves exactly as before)', () => {
    assert.deepEqual(parseOrigins(undefined, undefined), []);
    assert.deepEqual(parseOrigins('', []), []);
    assert.deepEqual(corsHeaders('https://lab.kylebaker.io', []), {});
    assert.deepEqual(corsHeaders(undefined, parseOrigins(undefined, undefined)), {});
});

test('the list: env wins over config, junk is dropped, trailing slashes trimmed', () => {
    assert.deepEqual(parseOrigins('https://a.example, http://127.0.0.1:4173/', ['https://ignored.example']), ['https://a.example', 'http://127.0.0.1:4173']);
    assert.deepEqual(parseOrigins(null, ['https://a.example', 'https://a.example', 'a.example', 'https://a.example/path', 'javascript:alert(1)', 'https://*.*.example', 7, null, '*']), ['https://a.example', '*']);
});

test('one exact origin: named on every answer, so a shared cache can never serve a copy without it', () => {
    const allow = parseOrigins(null, ['https://lab.kylebaker.io']);
    for (const origin of ['https://lab.kylebaker.io', 'https://evil.example', undefined]) {
        const h = corsHeaders(origin, allow);
        assert.equal(h['Access-Control-Allow-Origin'], 'https://lab.kylebaker.io');   // a page on evil.example gets a header that does not match it: the browser refuses
        assert.equal(h.Vary, undefined);
        assert.equal(h['Access-Control-Allow-Credentials'], undefined);
    }
});

test('several origins: the caller is echoed only when listed, and caches are told the answer varies', () => {
    const allow = parseOrigins(null, ['https://lab.kylebaker.io', 'https://ai-lab.netlify.app', 'https://*--ai-lab.netlify.app']);
    assert.deepEqual(corsHeaders('https://ai-lab.netlify.app', allow), { 'Access-Control-Allow-Origin': 'https://ai-lab.netlify.app', Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' });
    assert.equal(corsHeaders('https://deploy-preview-12--ai-lab.netlify.app', allow)['Access-Control-Allow-Origin'], 'https://deploy-preview-12--ai-lab.netlify.app');
    assert.deepEqual(corsHeaders('https://evil.example', allow), { Vary: 'Origin' });
    assert.deepEqual(corsHeaders(undefined, allow), { Vary: 'Origin' });
    // the wildcard is one label fragment: it cannot be stretched across dots or to another site
    assert.equal(originAllowed('https://x.evil.example--ai-lab.netlify.app', allow), false);
    assert.equal(originAllowed('https://a--ai-lab.netlify.app.evil.example', allow), false);
    assert.equal(originAllowed('http://lab.kylebaker.io', allow), false);
});

test('"*": any origin, still without credentials', () => {
    const h = corsHeaders('https://anything.example', parseOrigins('*', null));
    assert.equal(h['Access-Control-Allow-Origin'], '*');
    assert.equal(h['Access-Control-Allow-Credentials'], undefined);
});
