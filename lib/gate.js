'use strict';
// --- THE TUNNEL GATE'S LOGIN: what a wrong password gets (2026-10-22) ---
// Kyle: "let's have a failed password entry on ai.kylebaker.io forward you to lab.kylebaker.io". The private
// dashboard (server4.js) answers its tunnel hostname with a password page (TUNNEL_GATE_PAGE) that posts to
// /api/tunnel/login. A wrong password still gets the same 401 JSON as before -- the PBKDF2 check, the cookie on success
// and every other route's 401 (Bearer API clients, dash-cli) are untouched -- and now also names where to send the
// browser: remoteAccess.failRedirect in dashboard.config.json (the public site). The gate PAGE follows it; nothing else
// does, because only the page's own script reads `redirect`. Without the setting the page shows the error and lets you
// retry, as it always did.
// The gate has no rate limit or lockout (each attempt costs a 200k-round PBKDF2 on the server, ~0.1 s, and that is the
// only brake). The redirect adds no way around anything: the 401 and the check are the same, and the browser simply
// leaves instead of retrying.

/** remoteAccess.failRedirect -> an absolute http(s) URL, or null (unset, or anything else: never a javascript: URL). */
function failRedirectTarget(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let u;
    try { u = new URL(raw.trim()); } catch { return null; }
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
}

/** The answer to a wrong password: { status, body } (body is the JSON object to send). */
function loginFailure(remoteAccess) {
    const to = failRedirectTarget(remoteAccess && remoteAccess.failRedirect);
    return { status: 401, body: to ? { error: 'invalid password', redirect: to } : { error: 'invalid password' } };
}

// The gate page's script, kept here so the test runs the very code the page carries.
const GATE_PAGE_SCRIPT = `document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = document.getElementById('go');
  const err = document.getElementById('err');
  go.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/tunnel/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value })
    });
    if (r.ok) { location.reload(); return; }
    const j = await r.json().catch(() => ({}));
    // a wrong password: away to the configured page (remoteAccess.failRedirect), else say so and let them retry
    if (j.redirect && /^https?:\\/\\//i.test(j.redirect)) { location.replace(j.redirect); return; }
    err.textContent = j.error || 'Unlock failed';
  } catch (ex) { err.textContent = 'Unlock failed: ' + ex.message; }
  go.disabled = false;
});`;

module.exports = { failRedirectTarget, loginFailure, GATE_PAGE_SCRIPT };
