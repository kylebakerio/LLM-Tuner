'use strict';
// ui/shared/poll.js (2026-10-22): every dashboard poll stops while the page is hidden, runs once as soon as it is
// visible again, and never overlaps itself. A fake clock and document drive it, so the tests count runs exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { every } = require('../ui/shared/poll.js');

function fakeClock() {
    let now = 0, seq = 0;
    const timers = new Map();
    return {
        setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimeout(id) { timers.delete(id); },
        pending: () => timers.size,
        /** Advance to `to` ms, firing every timer that falls due on the way (and the microtasks each run queues). */
        async advance(by) {
            const to = now + by;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]); now = due[1].at; due[1].fn();
                for (let i = 0; i < 5; i++) await null;
            }
            now = to;
        },
    };
}
function fakeDoc(hidden = false) {
    const ls = new Set();
    return {
        hidden,
        addEventListener(k, fn) { if (k === 'visibilitychange') ls.add(fn); },
        removeEventListener(k, fn) { if (k === 'visibilitychange') ls.delete(fn); },
        listeners: () => ls.size,
        async set(h) { this.hidden = h; for (const fn of [...ls]) fn(); for (let i = 0; i < 5; i++) await null; },
    };
}

test('runs every ms while visible; opts.now runs once right away', async () => {
    const T = fakeClock(), doc = fakeDoc();
    let n = 0;
    const p = every(() => { n++; }, 1000, { doc, timers: T });
    assert.equal(n, 0);
    await T.advance(3500);
    assert.equal(n, 3);
    p.stop();
    let m = 0;
    every(() => { m++; }, 1000, { doc, timers: T, now: true });
    await null;
    assert.equal(m, 1);
});

test('nothing at all while hidden, one run the moment it is visible again, then the normal cadence', async () => {
    const T = fakeClock(), doc = fakeDoc();
    let n = 0;
    every(() => { n++; }, 1000, { doc, timers: T });
    await T.advance(2000);
    assert.equal(n, 2);
    await doc.set(true);
    await T.advance(60000);
    assert.equal(n, 2, 'no run in a hidden page');
    assert.equal(T.pending(), 0, 'and no timer left ticking');
    await doc.set(false);
    assert.equal(n, 3, 'one run on becoming visible');
    await T.advance(1000);
    assert.equal(n, 4);
});

test('never two runs at once: the next wait starts when a slow run has finished', async () => {
    const T = fakeClock(), doc = fakeDoc();
    let n = 0, running = 0, maxRunning = 0;
    const slow = () => new Promise((resolve) => { n++; running++; maxRunning = Math.max(maxRunning, running); T.setTimeout(() => { running--; resolve(); }, 2500); });
    const p = every(slow, 1000, { doc, timers: T });
    await T.advance(10000);   // 1000 wait + 2500 run per cycle
    assert.equal(maxRunning, 1);
    assert.equal(n, 3);
    p.now();                  // a run is in flight or due: now() starts no second one alongside it
    assert.ok(running <= 1);
});

test('ms may be a function: the cadence follows state, read after each run', async () => {
    const T = fakeClock(), doc = fakeDoc();
    let fast = false, n = 0;
    every(() => { n++; }, () => (fast ? 1000 : 3000), { doc, timers: T });
    await T.advance(9000);
    assert.equal(n, 3);
    fast = true;
    await T.advance(3000);    // the wait already armed (3 s) runs out first, then 1 s ones
    assert.equal(n, 4);
    await T.advance(3000);
    assert.equal(n, 7);
});

test('whileHidden keeps a recording run going in a hidden page, and only while it says so', async () => {
    const T = fakeClock(), doc = fakeDoc(true);
    let recording = true, n = 0;
    every(() => { n++; }, 1000, { doc, timers: T, whileHidden: () => recording });
    await T.advance(3000);
    assert.equal(n, 3);
    recording = false;
    await T.advance(5000);
    assert.equal(n, 3);
});

test('stop() ends it for good and lets go of the document; a throwing run does not end the poll', async () => {
    const T = fakeClock(), doc = fakeDoc();
    let n = 0;
    const errors = [];
    const was = console.error; console.error = (e) => errors.push(e);
    try {
        const p = every(() => { n++; throw new Error('boom'); }, 1000, { doc, timers: T });
        await T.advance(2000);
        assert.equal(n, 2);
        assert.equal(errors.length, 2);
        p.stop();
        assert.equal(doc.listeners(), 0);
        await T.advance(5000);
        await doc.set(true); await doc.set(false);
        assert.equal(n, 2);
    } finally { console.error = was; }
});

test('the classic script sets globalThis.Poll (what script.js reads) and ui/benchmarks/util.js re-exports it for the modules', async () => {
    assert.equal(typeof globalThis.Poll.every, 'function');
    const U = await import('../ui/benchmarks/util.js');
    assert.equal(U.pollEvery, globalThis.Poll.every);
});
