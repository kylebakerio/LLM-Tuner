import { Readable } from 'node:stream';

// Client for the Mission Control backend (server4.js).
//
// Two legs:
//   1. plain JSON REST (getJson/postJson) -- one-shot requests
//   2. an SSE connection to /api/status -- the live state stream
//
// The SSE leg is self-healing: on disconnect it reconnects with exponential
// backoff (1s..30s), and an idle watchdog treats 45s of silence (heartbeats
// arrive every 15s) as a dead connection and forces a reconnect. Connection
// state is reported via onConnState('connecting' | 'live' | 'reconnecting').
//
// When a `token` is set (tunnel gate password), every request -- REST and
// SSE alike -- carries `Authorization: Bearer <token>`. A 401 from a gated
// dashboard lands on the thrown error as `err.authRequired = true` so the
// caller can offer a password prompt instead of a generic failure.

const IDLE_TIMEOUT_MS = 45000;
const WATCHDOG_INTERVAL_MS = 10000;
const MAX_BACKOFF_MS = 30000;

export class McClient {
  constructor(baseUrl, { onEvent, onConnState, fetchImpl, token } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.onEvent = onEvent || (() => {});
    this.onConnState = onConnState || (() => {});
    this.token = token || null;
    this._fetch = fetchImpl || globalThis.fetch;
    this._aborts = new Set();
    this._closed = false;
    this._attempts = 0;
    this._everLive = false;
    this._reconnectTimer = null;
    this._watchdog = null;
    this._lastByte = 0;
  }

  _authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  _throwHttp(p, status, data) {
    const err = new Error(data?.error || `${p} -> HTTP ${status}`);
    err.status = status;
    err.data = data;
    if (status === 401) err.authRequired = true;
    throw err;
  }

  async getJson(p, { timeoutMs = 10000 } = {}) {
    const res = await this._fetch(this.baseUrl + p, {
      headers: this._authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 401) {
        const err = new Error(`${p} -> HTTP 401 (authentication required)`);
        err.status = 401;
        err.authRequired = true;
        throw err;
      }
      throw new Error(`${p} -> HTTP ${res.status}`);
    }
    return res.json();
  }

  async postJson(p, body, { timeoutMs = 20000 } = {}) {
    const res = await this._fetch(this.baseUrl + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${res.status}` }; }
    if (!res.ok) this._throwHttp(p, res.status, data);
    return data;
  }

  // Streaming POST (chat completions). Returns the raw Response so the caller
  // can read res.body incrementally; throws with authRequired on a 401. No
  // wall-clock timeout by default: an active stream is alive, and a fixed
  // AbortSignal would kill long generations mid-thought. Pass timeoutMs only
  // to cap the time-to-FIRST-byte for dead-connection detection.
  async postStream(p, body, { timeoutMs, signal } = {}) {
    // Combine a first-byte timeout (if given) with the caller's cancel signal.
    let sig = signal;
    if (timeoutMs) {
      sig = signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
        : AbortSignal.timeout(timeoutMs);
    }
    const res = await this._fetch(this.baseUrl + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify(body ?? {}),
      ...(sig ? { signal: sig } : {}),
    });
    if (!res.ok) {
      let data;
      try { data = JSON.parse(await res.text()); } catch { data = { error: `HTTP ${res.status}` }; }
      this._throwHttp(p, res.status, data);
    }
    return res;
  }

  async deleteJson(p, { timeoutMs = 10000 } = {}) {
    const res = await this._fetch(this.baseUrl + p, {
      method: 'DELETE',
      headers: this._authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${res.status}` }; }
    if (!res.ok) this._throwHttp(p, res.status, data);
    return data;
  }

  connect() {
    if (this._closed || this._reconnectTimer) return;
    this._attempts += 1;
    // First attempt before ever being live is "connecting"; anything after
    // (including a dropped-then-retrying stream) is "reconnecting".
    this.onConnState(this._attempts === 1 && !this._everLive ? 'connecting' : 'reconnecting');

    const ac = new AbortController();
    this._aborts.add(ac);
    this._lastByte = Date.now();

    this._fetch(this.baseUrl + '/api/status', {
      headers: { Accept: 'text/event-stream', ...this._authHeaders() },
      signal: ac.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
        this._everLive = true;
        this._attempts = 1; // a drop after a stable connection fast-reconnects (1s)
        this.onConnState('live');
        this._watchdog = setInterval(() => {
          if (Date.now() - this._lastByte > IDLE_TIMEOUT_MS) ac.abort();
        }, WATCHDOG_INTERVAL_MS);

        const stream = Readable.fromWeb(res.body);
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of stream) {
          this._lastByte = Date.now();
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this._handleFrame(frame);
          }
        }
        throw new Error('stream ended');
      })
      .catch(() => {
        this._clearTimers();
        this._aborts.delete(ac);
        if (!this._closed) this._scheduleReconnect();
      })
      .finally(() => this._clearTimers());
  }

  _handleFrame(frame) {
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat comment
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        this.onEvent(JSON.parse(payload));
      } catch {
        // non-JSON frame -- ignore, keep the connection
      }
    }
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this._attempts - 1, 5));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _clearTimers() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
  }

  close() {
    this._closed = true;
    this._clearTimers();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    for (const ac of this._aborts) { try { ac.abort(); } catch { /* already aborted */ } }
    this._aborts.clear();
  }
}
