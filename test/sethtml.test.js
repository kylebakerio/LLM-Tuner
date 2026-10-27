'use strict';
// ui/benchmarks/util.js setHtml(): a redraw must keep scroll containers (and kept components) as the SAME nodes --
// replacing them is what reset scroll positions and killed in-flight scroll gestures (Kyle, 2026-10-06) -- while
// everything else is replaced by fresh nodes, and listeners never pile up on the nodes that persist.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');

async function setup() {
    const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    const U = await import('../ui/benchmarks/util.js');
    U.recordListeners(window);
    return { U, window, document, root: document.getElementById('root') };
}
const view = (rows, extra = '') => `<h3 class="title">t</h3>${extra}<div class="card"><div class="overflow-y-auto" style="max-height:16rem">${rows.map((r) => `<p>${r}</p>`).join('')}</div><button data-act="go">go</button></div>`;

test('an unkeyed scroll container survives a redraw as the same node; its rows and the button are fresh', async () => {
    const { U, root } = await setup();
    U.setHtml(root, view(['a', 'b']));
    const scroller = root.querySelector('.overflow-y-auto'), card = root.querySelector('.card'), button = root.querySelector('button'), title = root.querySelector('h3');
    U.setHtml(root, view(['a', 'b', 'c']));
    assert.equal(root.querySelector('.overflow-y-auto'), scroller, 'the scroller is the same element');
    assert.equal(root.querySelector('.card'), card, 'so is its ancestor');
    assert.notEqual(root.querySelector('button'), button, 'a plain button is replaced');
    assert.notEqual(root.querySelector('h3'), title);
    assert.deepEqual(Array.from(scroller.querySelectorAll('p')).map((p) => p.textContent), ['a', 'b', 'c']);
});

test('a block appearing above the scroller does not cost it its identity', async () => {
    const { U, root } = await setup();
    U.setHtml(root, view(['a']));
    const scroller = root.querySelector('.overflow-y-auto');
    U.setHtml(root, view(['a', 'b'], '<div class="banner">paused</div>'));
    assert.equal(root.querySelector('.overflow-y-auto'), scroller);
    assert.equal(root.querySelector('.banner').textContent, 'paused');
    U.setHtml(root, view(['a', 'b']));
    assert.equal(root.querySelector('.overflow-y-auto'), scroller);
    assert.equal(root.querySelector('.banner'), null);
});

test('listeners a view adds after each redraw never pile up on a node that persists', async () => {
    const { U, root, window } = await setup();
    let clicks = 0;
    const html = '<div class="overflow-auto" data-key="box"><span>x</span></div>';
    for (let i = 0; i < 5; i++) {
        U.setHtml(root, html);
        root.querySelector('[data-key=box]').addEventListener('click', () => { clicks++; });
    }
    root.querySelector('[data-key=box]').dispatchEvent(new window.Event('click'));
    assert.equal(clicks, 1);
});

test('a data-keep element keeps its children (a mounted component) and its node', async () => {
    const { U, root, document } = await setup();
    const html = (n) => `<p>tick ${n}</p><div data-keep data-lc-host class="flex"></div>`;
    U.setHtml(root, html(1));
    const host = root.querySelector('[data-lc-host]');
    const chat = document.createElement('section'); chat.textContent = 'chat';
    host.appendChild(chat);
    U.setHtml(root, html(2));
    assert.equal(root.querySelector('[data-lc-host]'), host);
    assert.equal(host.firstChild, chat, 'the component was neither removed nor moved');
    assert.equal(root.querySelector('p').textContent, 'tick 2');
    U.setHtml(root, '<p>gone</p>');
    assert.equal(root.querySelector('[data-lc-host]'), null);
});

test("a persisted <details> keeps the reader's open/closed state; attributes otherwise follow the new HTML", async () => {
    const { U, root } = await setup();
    const html = (cls) => `<details class="${cls}"><summary>s</summary><pre class="overflow-auto">log</pre></details>`;
    U.setHtml(root, html('a'));
    const det = root.querySelector('details');
    det.setAttribute('open', '');
    U.setHtml(root, html('b'));
    assert.equal(root.querySelector('details'), det);
    assert.ok(det.hasAttribute('open'));
    assert.equal(det.getAttribute('class'), 'b');
});

test('keyed siblings are told apart when one above goes away', async () => {
    const { U, root } = await setup();
    const box = (k) => `<div data-key="${k}" class="overflow-auto">${k}</div>`;
    U.setHtml(root, box('one') + box('two'));
    const two = root.querySelector('[data-key=two]');
    U.setHtml(root, box('two'));
    assert.equal(root.querySelector('[data-key=two]'), two);
    assert.equal(root.children.length, 1);
});

test('a parent redraw never captures or restores state inside a kept component (2026-10-22, util.js rule 4)', async () => {
    const { U, root, document } = await setup();
    // linkedom has no `open` property on <details> (captureUiState reads it): the attribute, as a browser reflects it
    Object.defineProperty(Object.getPrototypeOf(document.createElement('details')), 'open', { configurable: true,
        get() { return this.tagName === 'DETAILS' ? this.hasAttribute('open') : undefined; },
        set(v) { if (this.tagName === 'DETAILS') { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); } } });
    // the kept host holds a component with its own keyed <details>; the parent has one with the SAME key
    const page = '<div data-key="x" class="a"><details data-key="dup"><summary>p</summary></details></div><div data-keep data-lc-host></div>';
    U.setHtml(root, page);
    const host = root.querySelector('[data-lc-host]');
    host.innerHTML = '<details data-key="dup" open><summary>c</summary></details>';
    U.setHtml(root, page);
    assert.ok(host.querySelector('details').hasAttribute('open'), 'the component\'s block was not closed by the parent\'s same-keyed one');
    assert.ok(!root.querySelector('[data-key=x] details').hasAttribute('open'), 'and the parent\'s block did not take the component\'s state');
    // the other way round: the component's block closed, the parent's opened by its reader
    host.querySelector('details').removeAttribute('open');
    root.querySelector('[data-key=x] details').setAttribute('open', '');
    U.setHtml(root, page);
    assert.ok(!host.querySelector('details').hasAttribute('open'), 'the component keeps its own closed block closed');
    assert.ok(root.querySelector('[data-key=x] details').hasAttribute('open'));
});
