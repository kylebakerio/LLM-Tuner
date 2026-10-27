'use strict';
// lib/reqtally.js (2026-10-22): the dashboard's in-memory request tally behind GET /api/debug/requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const R = require('../lib/reqtally');

const req = (url, headers = {}) => ({ url, headers: { host: 'localhost:3000', ...headers } });
function res(statusCode = 200) { const r = new EventEmitter(); r.statusCode = statusCode; return r; }

test('path patterns: no query, the asset hash and ids folded', () => {
    assert.equal(R.pathPattern('/api/lanes/live'), '/api/lanes/live');
    assert.equal(R.pathPattern('/api/codebench/transcript?dir=x&task=y'), '/api/codebench/transcript');
    assert.equal(R.pathPattern('/v/0123abcd4567/ui/models/index.js'), '/v/<hash>/ui/*');
    assert.equal(R.pathPattern('/v/0123abcd4567/script.js'), '/v/<hash>/*');
    assert.equal(R.pathPattern('/v/0123abcd4567/vendor/chart.js'), '/v/<hash>/vendor/*');
    assert.equal(R.pathPattern('/ui/benchmarks/live.js?v=1'), '/ui/*');
    assert.equal(R.pathPattern('/api/queue/1234/note'), '/api/queue/:n/note');
    assert.equal(R.pathPattern('/api/profiles/my%20profile'), '/api/profiles/:name');
    assert.equal(R.pathPattern(''), '/');
});

test('way in: the public hostname is the tunnel; localhost, addresses and LAN / tailnet names are local', () => {
    assert.deepEqual(R.wayIn('ai.kylebaker.io'), { name: 'ai.kylebaker.io', via: 'tunnel' });
    for (const h of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '192.168.1.20:3000', 'desktop:3000', 'desktop.tail1234.ts.net:3000', ''])
        assert.equal(R.wayIn(h).via, 'local', h);
});

test('credentials as sent: bearer, cookie (mc_session only), none', () => {
    assert.equal(R.authKind({ authorization: 'Bearer x' }), 'bearer');
    assert.equal(R.authKind({ cookie: 'a=1; mc_session=s1.1.2.abc' }), 'cookie');
    assert.equal(R.authKind({ cookie: 'other=1' }), 'none');
    assert.equal(R.authKind({}), 'none');
});

test('counts by path, way in, credentials, agent and status; per minute over a moving window', () => {
    let t = Date.UTC(2026, 9, 22, 4, 0, 0);
    const T = R.createTally({ now: () => t });
    const ua = { 'user-agent': 'Mozilla/5.0 Chrome' };
    for (let i = 0; i < 60; i++) {
        const a = res(), b = res(i % 10 ? 200 : 401);
        T.count(req('/api/telemetry/latest', { host: 'ai.kylebaker.io', cookie: 'mc_session=x', ...ua }), a); a.emit('finish');
        T.count(req('/api/lanes/live', ua), b); b.emit('finish');
        t += 1000;
    }
    t += 60000;   // a whole quiet minute later
    const s = T.snapshot();
    assert.equal(s.total, 120);
    assert.deepEqual(s.via, { tunnel: 60, local: 60 });
    assert.deepEqual(s.auth, { cookie: 60, none: 60 });
    assert.equal(s.status['200'], 114);
    assert.equal(s.status['401'], 6);
    assert.deepEqual(s.byPath.map((p) => [p.path, p.n, p.tunnel, p.local]), [['/api/telemetry/latest', 60, 60, 0], ['/api/lanes/live', 60, 0, 60]]);
    assert.equal(s.topAgents[0].ua, 'Mozilla/5.0 Chrome');
    assert.equal(s.hosts['ai.kylebaker.io'], 60);
    // the minute with traffic and the quiet one after it: 120 requests over 2 whole minutes
    assert.equal(s.recent.minutes, 2);
    assert.equal(s.recent.n, 120);
    assert.equal(s.recent.perMin, 60);
    assert.equal(s.recent.byPath[0].perMin, 30);
    assert.ok(s.lastMinutes.length >= 2);
    // an hour later the per-minute window has moved on; the totals since start stay
    t += 61 * 60000;
    const later = T.snapshot();
    assert.equal(later.recent.n, 0);
    assert.ok(later.lastMinutes.every((m) => m.n === 0));
    assert.equal(later.total, 120);
});

test('the maps are capped: new paths past the cap count as (other)', () => {
    const T = R.createTally();
    for (let i = 0; i < 400; i++) T.count(req(`/api/x${i}`), null);
    const s = T.snapshot();
    assert.equal(s.total, 400);
    assert.ok(s.byPath.length <= 301);
    assert.equal(s.byPath.reduce((a, p) => a + p.n, 0), 400);
    assert.ok(s.byPath.some((p) => p.path === '(other)'));
});

test('server4.js counts every request before the gate and serves the tally behind it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server4.js'), 'utf8');
    const top = src.indexOf('const server = http.createServer(');
    const counted = src.indexOf('reqTally.count(req, res)', top);
    const gate = src.indexOf('if (tunnelGateActive())', top);
    assert.ok(top > 0 && counted > top && counted < gate, 'counted at the top of the handler, before OPTIONS and the gate');
    const route = src.indexOf("req.url === '/api/debug/requests'");
    assert.ok(route > gate, 'the tally route is after the gate');
});
