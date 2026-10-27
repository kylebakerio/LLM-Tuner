'use strict';
// The tunnel gate's login (lib/gate.js, 2026-10-22, Kyle: "let's have a failed password entry on ai.kylebaker.io forward
// you to lab.kylebaker.io"): a wrong password is still a 401 JSON; with remoteAccess.failRedirect set it also names the
// public site, and the gate PAGE (its script, run here in a DOM) goes there instead of offering a retry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');
const G = require('../lib/gate');

test('failRedirect: only an absolute http(s) URL is ever followed', () => {
    assert.equal(G.failRedirectTarget('https://lab.kylebaker.io/'), 'https://lab.kylebaker.io/');
    assert.equal(G.failRedirectTarget(' https://lab.kylebaker.io '), 'https://lab.kylebaker.io/');
    for (const bad of [undefined, null, '', '  ', 'javascript:alert(1)', '/relative', 'lab.kylebaker.io', 'data:text/html,x', 42]) assert.equal(G.failRedirectTarget(bad), null, String(bad));
});

test('a wrong password is a 401 JSON either way; the redirect is only a field in it', () => {
    assert.deepEqual(G.loginFailure({}), { status: 401, body: { error: 'invalid password' } });
    assert.deepEqual(G.loginFailure(undefined), { status: 401, body: { error: 'invalid password' } });
    assert.deepEqual(G.loginFailure({ failRedirect: 'https://lab.kylebaker.io/' }), { status: 401, body: { error: 'invalid password', redirect: 'https://lab.kylebaker.io/' } });
    assert.deepEqual(G.loginFailure({ failRedirect: 'javascript:x' }), { status: 401, body: { error: 'invalid password' } });
});

// The page's own script against a stubbed /api/tunnel/login.
async function submitWith(answer) {
    const { window, document } = parseHTML('<!doctype html><html><body><form id="f"><input id="pw" value="nope"><button id="go">Unlock</button></form><p id="err"></p></body></html>');
    const calls = { replace: [], reload: 0, fetch: [] };
    const location = { replace: (u) => calls.replace.push(u), reload: () => { calls.reload++; } };
    const fetch = async (url, opts) => { calls.fetch.push([url, JSON.parse(opts.body)]); return answer; };
    new Function('document', 'fetch', 'location', G.GATE_PAGE_SCRIPT)(document, fetch, location);
    document.getElementById('f').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    return { calls, err: document.getElementById('err').textContent, disabled: document.getElementById('go').disabled };
}

test('the gate page: a wrong password with failRedirect leaves for it; without one it says so and allows a retry', async () => {
    const away = await submitWith({ ok: false, status: 401, json: async () => G.loginFailure({ failRedirect: 'https://lab.kylebaker.io/' }).body });
    assert.deepEqual(away.calls.fetch, [['/api/tunnel/login', { password: 'nope' }]]);
    assert.deepEqual(away.calls.replace, ['https://lab.kylebaker.io/']);
    const stay = await submitWith({ ok: false, status: 401, json: async () => G.loginFailure({}).body });
    assert.deepEqual(stay.calls.replace, []);
    assert.equal(stay.err, 'invalid password');
    assert.equal(stay.disabled, false, 'the button is back for another try');
    const odd = await submitWith({ ok: false, status: 401, json: async () => ({ error: 'invalid password', redirect: 'javascript:alert(1)' }) });
    assert.deepEqual(odd.calls.replace, [], 'never a javascript: URL, whatever the answer says');
    const ok = await submitWith({ ok: true, status: 200, json: async () => ({ ok: true }) });
    assert.equal(ok.calls.reload, 1, 'a right password reloads into the dashboard, as before');
    assert.deepEqual(ok.calls.replace, []);
});

test('server4.js serves this script on its gate page and answers a wrong password through loginFailure', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server4.js'), 'utf8');
    const page = src.slice(src.indexOf('const TUNNEL_GATE_PAGE'), src.indexOf('</html>`;', src.indexOf('const TUNNEL_GATE_PAGE')));
    assert.match(page, /\$\{gateModel\.GATE_PAGE_SCRIPT\}/);
    const login = src.slice(src.indexOf("req.url === '/api/tunnel/login'"), src.indexOf('tunnelGateResponse(req, res)', src.indexOf("req.url === '/api/tunnel/login'")));
    assert.match(login, /verifyTunnelPassword\(body\.password\)/, 'the password check is unchanged');
    assert.match(login, /gateModel\.loginFailure\(dashboardConfig\.remoteAccess\)/);
    assert.doesNotMatch(login, /writeHead\(30[12378]/, 'never an HTTP redirect: API clients get JSON');
});
