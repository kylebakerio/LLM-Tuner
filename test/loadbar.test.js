'use strict';
// ui/shared/loadbar.js (2026-10-22, Kyle: "the 'loading' for that page should have a loading bar and a better animation --
// that goes for both ai and lab subdomain pages"): the bar moves only on real events, the public site and the module
// draw the same steps, and the public site serves (and its static build carries) the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');
const load = () => import('../ui/shared/loadbar.js');

test('the fraction counts finished steps whole, the running one only by what it measured, the rest nothing', async () => {
    const L = await load();
    const steps = [{ id: 'a', state: 'done' }, { id: 'b', state: 'active', frac: 0.5 }, { id: 'c', state: 'todo' }, { id: 'd', state: 'todo' }];
    assert.equal(L.loadFraction(steps), 1.5 / 4);
    assert.equal(L.loadFraction([{ id: 'a', state: 'active' }, { id: 'b' }]), 0, 'a step that cannot measure itself adds nothing until it ends');
    assert.equal(L.loadFraction([]), 0);
    const html = L.loadPanelHtml('Loading the results', steps);
    assert.match(html, /aria-valuenow="38"/); assert.match(html, /width:37\.5%/);
    assert.match(html, /data-step="b" data-state="active"/);
});

test('a panel updates in place: start() finishes the earlier steps, set() changes one', async () => {
    const L = await load();
    const { document } = parseHTML('<!doctype html><html><head></head><body><div id="p"></div></body></html>');
    const el = document.getElementById('p');
    const panel = L.createLoadPanel(el, L.RESULTS_TITLE, L.RESULTS_STEPS);
    const node = el.querySelector('.lb-panel');
    panel.start('data');
    panel.set('data', { frac: 0.5, detail: '2.0 MB of 4.0 MB' });
    assert.equal(el.querySelector('.lb-panel'), node, 'the same node: its animations keep running');
    assert.equal(el.querySelector('[data-step=code]').dataset.state, 'done');
    assert.equal(el.querySelector('[data-step=data] .lb-detail').textContent, '2.0 MB of 4.0 MB');
    assert.equal(el.querySelector('.lb-fill').style.width, `${((1.5 / L.RESULTS_STEPS.length) * 100).toFixed(1)}%`);
    assert.ok(document.getElementById('loadbar-style'), 'its few rules come with it (the prebuilt tailwind has none)');
    assert.deepEqual(L.RESULTS_STEPS.map((s) => s.id), ['code', 'data', 'parse', 'fit', 'draw']);
});

test('both sites use it: the public server serves the file, its static build lists it, site.js and the module import it', () => {
    const dash = path.join(__dirname, '..');
    const server = fs.readFileSync(path.join(dash, 'public', 'server.js'), 'utf8');
    assert.match(server, /'ui\/shared\/loadbar\.js'/);
    assert.ok(require('../public/staticsite').ASSET_FILES.some(([k]) => k === 'ui/shared/loadbar.js'));
    assert.match(fs.readFileSync(path.join(dash, 'public', 'assets', 'site.js'), 'utf8'), /from '\.\.\/ui\/shared\/loadbar\.js'/);
    assert.match(fs.readFileSync(path.join(dash, 'ui', 'models', 'index.js'), 'utf8'), /from '\.\.\/shared\/loadbar\.js'/);
});
