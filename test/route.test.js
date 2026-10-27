'use strict';
// ui/shared/route.js: the routes (parse / format / resolve) and the router over them. The requirement it exists
// for (Kyle, 2026-10-06): every in-app navigation is ONE history entry, and Back/Forward restore exactly the view
// that was showing. So the tests are about entries: when one is added, when it must not be, and what Back draws.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../ui/shared/route.js');

// A window with just enough history: entries are { state, hash }, Back/Forward fire popstate (and hashchange when
// the hash differs) as a browser does, synchronously here, and typing a hash adds an entry with no state.
function fakeWindow(hash = '') {
    const entries = [{ state: null, hash }];
    const listeners = {};
    let i = 0;
    const fire = (k) => (listeners[k] || []).forEach((fn) => fn({}));
    // history.back() called from inside a listener (the router does) takes effect after that event, as in a browser
    let dispatching = false; const queued = [];
    const move = (d) => {
        if (dispatching) { queued.push(d); return; }
        if (!entries[i + d]) return;
        const was = entries[i].hash; i += d;
        dispatching = true;
        try { fire('popstate'); if (entries[i].hash !== was) fire('hashchange'); } finally { dispatching = false; }
        while (queued.length) move(queued.shift());
    };
    const win = {
        location: { get hash() { return entries[i].hash; } },
        history: {
            get state() { return entries[i].state; },
            pushState(s, _t, url) { entries.splice(i + 1); entries.push({ state: s, hash: url == null ? entries[i].hash : url }); i++; },
            replaceState(s, _t, url) { entries[i] = { state: s, hash: url == null ? entries[i].hash : url }; },
            back() { move(-1); }, forward() { move(1); },
        },
        addEventListener(k, fn) { (listeners[k] = listeners[k] || []).push(fn); },
        setInterval: () => 1, clearInterval() {},
    };
    const typeHash = (h) => { entries.splice(i + 1); entries.push({ state: null, hash: h }); i++; fire('popstate'); fire('hashchange'); };
    return { win, entries, typeHash, hashes: () => entries.map((e) => e.hash), at: () => i };
}
function started(hash, opts) {
    const w = fakeWindow(hash);
    const nav = R.createRouter(w.win);
    const drawn = [];
    nav.on((r, info) => drawn.push(R.format(r) + (info.again ? ' again:' + info.again : '')));
    nav.start(opts);
    return { ...w, nav, drawn };
}

test('every route survives format -> parse -> format, including names that need encoding', () => {
    const routes = [
        { tab: 'interactive' }, { tab: 'monitor' }, { tab: 'history' }, { tab: 'models' },
        { tab: 'bench', sub: 'hw' }, { tab: 'bench', sub: 'server' }, { tab: 'bench', sub: 'suites' },
        ...R.CB_VIEWS.map((view) => ({ tab: 'bench', sub: 'codebench', view })),
        { tab: 'bench', sub: 'codebench', view: 'runs', dir: 'qwen3.8-27b-udq4kxl-80k' },
        { tab: 'bench', sub: 'codebench', view: 'live', dir: 'a battery/with 100% odd#name' },
        { tab: 'bench', sub: 'codebench', view: 'live', dir: 'bat-1', task: 'demo-widget-off-by-one__r2' },
        { tab: 'models', model: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL', view: 'speed' },
        { tab: 'models', model: 'claude-opus-5 (xhigh)', view: 'quality' },
        { tab: 'models', task: 'demo-pager-skips-rows' },
        // the Solve map's compare page (2026-10-11): two row ids -- a model key, or a config group's key (JSON)
        { tab: 'models', compare: ['local:qwen3.8-27b:q4-k-xl', 'cloud:anthropic:claude-haiku-5-5@medium/solo+advisor:claude-sonnet-5-5'] },
        { tab: 'models', compare: ['[["weights","local:swift-qwen3.8-27b:q4-k-l"],["context",32768],["other",null]]', 'local:a b#c%d'] },
        // any number of rows (2026-10-20): one id per segment, in the order ticked
        { tab: 'models', compare: ['local:a', 'org/b:Q4', '[["weights","local:c"]]', 'cloud:d@low/solo', 'e'] },
    ];
    for (const r of routes) {
        const hash = R.format(r);
        assert.deepEqual(R.parse(hash), r, hash);
        assert.equal(R.format(R.parse(hash)), hash);
        assert.equal(hash.split('#').length, 2, `${hash}: a name's own # is encoded`);
    }
});

test('the route formats are the documented ones', () => {
    assert.equal(R.format({ tab: 'bench', sub: 'hw' }), '#bench/llama-bench');
    assert.equal(R.format({ tab: 'bench', sub: 'server' }), '#bench/sweep');
    assert.equal(R.format({ tab: 'bench', sub: 'codebench', view: 'live', dir: 'b', task: 't' }), '#bench/codebench/live/b/t');
    assert.equal(R.format({ tab: 'bench', sub: 'codebench', view: 'runs', dir: 'b', task: 't' }), '#bench/codebench/runs/b', 'a task only exists under live');
    assert.equal(R.format({ tab: 'bench', sub: 'codebench', view: 'board', dir: 'b' }), '#bench/codebench/board', 'a battery only under runs and live');
    // the Results tab (called Models until 2026-10-22: `models` inside the app, #results in the URL)
    assert.equal(R.format({ tab: 'models' }), '#results');
    assert.equal(R.format({ tab: 'models', model: 'm', view: 'speed' }), '#results/m', 'speed is the default tab');
    assert.equal(R.format({ tab: 'models', model: 'm', view: 'quality' }), '#results/m/quality');
    assert.equal(R.format({ tab: 'models', task: 'a/b' }), '#results/task/a%2Fb');
    assert.equal(R.format({ tab: 'models', compare: ['a/b', 'c'] }), '#results/compare/a%2Fb/c');
    assert.equal(R.format({ tab: 'models', compare: ['a'] }), '#results', 'a comparison needs two rows');
    assert.equal(R.format({ tab: 'models', compare: ['a', 'b/c', 'd'] }), '#results/compare/a/b%2Fc/d', 'three rows: one encoded id per segment');
    assert.equal(R.format({ tab: 'models', compare: ['a', ''] }), '#results', 'an empty id is not a row');
    assert.notEqual(R.format({ tab: 'models', compare: ['a', 'b'] }), R.format({ tab: 'models', compare: ['b', 'a'] }), 'the sides are ordered: swapped is another view');
    assert.equal(R.format(null), '#interactive');
    assert.equal(R.format({ tab: 'nope' }), '#interactive');
});

test('links that already exist keep opening the same view', () => {
    assert.deepEqual(R.parse(''), { tab: 'interactive' });
    assert.deepEqual(R.parse('#'), { tab: 'interactive' });
    assert.deepEqual(R.parse('#no-such-tab'), { tab: 'interactive' });
    for (const tab of R.TABS) assert.equal(R.parse('#' + tab).tab, tab);
    // the Models pages: ui/models/index.js wrote these two formats before the router existed
    assert.deepEqual(R.parse('#models/' + encodeURIComponent('org/model:Q4_K_M')), { tab: 'models', model: 'org/model:Q4_K_M', view: 'speed' });
    assert.deepEqual(R.parse('#models/task/' + encodeURIComponent('some task')), { tab: 'models', task: 'some task' });
    assert.deepEqual(R.parse('#models/org/model'), { tab: 'models', model: 'org/model', view: 'speed' }, 'a key typed with its slash unencoded is still one key');
    assert.deepEqual(R.parse('#models/org/model/quality'), { tab: 'models', model: 'org/model', view: 'quality' });
    assert.deepEqual(R.parse('#models/quality'), { tab: 'models', model: 'quality', view: 'speed' }, 'a lone segment is a key, never a tab name');
    assert.deepEqual(R.parse('#models/task'), { tab: 'models', model: 'task', view: 'speed' }, 'task/ needs an id to be a task page');
    // the compare page: two ids, or it is a model key as before
    assert.deepEqual(R.parse('#models/compare/' + encodeURIComponent('org/a:Q4') + '/' + encodeURIComponent('b@low/solo')), { tab: 'models', compare: ['org/a:Q4', 'b@low/solo'] });
    // 2026-10-20: a further segment is a further row (any number of rows); the app has always encoded an id's own "/"
    assert.deepEqual(R.parse('#models/compare/a/b/c'), { tab: 'models', compare: ['a', 'b', 'c'] }, 'three segments are three rows');
    assert.deepEqual(R.parse('#models/compare/a/b/'), { tab: 'models', compare: ['a', 'b'] }, 'a trailing slash adds no row');
    assert.deepEqual(R.parse('#models/compare/a/b'), { tab: 'models', compare: ['a', 'b'] }, 'a two-row link opens as before');
    assert.deepEqual(R.parse('#models/compare'), { tab: 'models', model: 'compare', view: 'speed' }, 'compare/ needs two ids to be a comparison');
    assert.deepEqual(R.parse('#models/compare/a'), { tab: 'models', model: 'compare/a', view: 'speed' });
    // Models -> Results (2026-10-22): every #models link is the same page under #results
    for (const h of ['', '/m', '/m/quality', '/task/t', '/compare/a/b', '/compare/a/b/c', '/org/model']) assert.deepEqual(R.parse('#models' + h), R.parse('#results' + h), '#models' + h);
    assert.equal(R.format(R.parse('#models/compare/a/b')), '#results/compare/a/b');
    // the live chat was a top-level tab until 2026-09-25
    assert.deepEqual(R.parse('#livechat'), { tab: 'bench', sub: 'codebench', view: 'live', chat: true });
    assert.equal(R.format(R.parse('#livechat')), '#bench/codebench/live');
    // the sub-tab's internal id works as well as its word
    assert.equal(R.parse('#bench/hw').sub, 'hw');
    assert.equal(R.parse('#bench/server').sub, 'server');
});

test('parse never throws and never invents a view', () => {
    assert.deepEqual(R.parse('#bench/nonsense'), { tab: 'bench', sub: null });
    assert.deepEqual(R.parse('#bench/codebench/nonsense/x'), { tab: 'bench', sub: 'codebench', view: null });
    assert.deepEqual(R.parse('#bench/codebench/board/x'), { tab: 'bench', sub: 'codebench', view: 'board' });
    assert.deepEqual(R.parse('#bench/codebench/live/50%/t'), { tab: 'bench', sub: 'codebench', view: 'live', dir: '50%', task: 't' }, 'a bad escape reads as itself');
    assert.deepEqual(R.parse('#bench/codebench/live/a%20b'), { tab: 'bench', sub: 'codebench', view: 'live', dir: 'a b' });
    assert.deepEqual(R.parse(undefined), { tab: 'interactive' });
});

test('resolve fills a short link from what was last used, and falls back when that is stale', () => {
    assert.equal(R.format(R.resolve(R.parse('#bench'), { sub: 'server' })), '#bench/sweep');
    assert.equal(R.format(R.resolve(R.parse('#bench'), { sub: 'codebench', view: 'queue' })), '#bench/codebench/queue');
    assert.equal(R.format(R.resolve(R.parse('#bench/codebench'), { sub: 'hw', view: 'live' })), '#bench/codebench/live');
    assert.equal(R.format(R.resolve(R.parse('#bench'), null)), '#bench/llama-bench');
    assert.equal(R.format(R.resolve(R.parse('#bench'), { sub: 'gone', view: 'gone' })), '#bench/llama-bench');
    assert.equal(R.format(R.resolve(R.parse('#bench/codebench'), { view: 'transcript' })), '#bench/codebench/runs', 'a stale key must not blank the card');
    assert.equal(R.format(R.resolve(R.parse('#bench/sweep'), { sub: 'codebench', view: 'live' })), '#bench/sweep', 'what the link says wins');
    const models = R.parse('#models/m');
    assert.equal(R.resolve(models, { sub: 'hw' }), models);
});

test('a navigation is one entry; going where you already are is none', () => {
    const { nav, hashes, drawn } = started('');
    assert.deepEqual(hashes(), [''], 'a bare URL stays bare');
    assert.deepEqual(drawn, ['#interactive']);
    nav.go('#monitor');
    nav.go('#monitor');
    nav.go(R.format({ tab: 'monitor' }));
    assert.deepEqual(hashes(), ['', '#monitor']);
    assert.deepEqual(drawn, ['#interactive', '#monitor'], 'and nothing is redrawn for it');
    nav.go('#interactive');
    assert.deepEqual(hashes(), ['', '#monitor', '#interactive']);
});

test('pressing a button for the open view again refreshes it without an entry, only when the button says so', () => {
    const { nav, hashes, drawn } = started('#history');
    nav.go('#history', { again: 'tab' });
    assert.deepEqual(hashes(), ['#history']);
    assert.deepEqual(drawn, ['#history', '#history again:tab']);
    nav.go('#monitor', { again: 'tab' });
    assert.deepEqual(drawn.slice(2), ['#monitor'], 'a real move is not a refresh');
});

test('Back and Forward draw the entry they land on', () => {
    const { win, nav, drawn } = started('#interactive');
    nav.go('#bench/codebench/runs');
    nav.go('#bench/codebench/runs/bat-1');
    nav.go('#bench/codebench/live/bat-1/task-a');
    drawn.length = 0;
    win.history.back();
    win.history.back();
    win.history.forward();
    win.history.back();
    win.history.back();
    assert.deepEqual(drawn, ['#bench/codebench/runs/bat-1', '#bench/codebench/runs', '#bench/codebench/runs/bat-1', '#bench/codebench/runs', '#interactive']);
    assert.deepEqual(nav.current(), { tab: 'interactive' });
});

test('a short or old link is rewritten in place to its one spelling, never as an extra entry', () => {
    const a = started('#bench', { defaults: () => ({ sub: 'codebench', view: 'live' }) });
    assert.deepEqual(a.hashes(), ['#bench/codebench/live']);
    assert.deepEqual(a.drawn, ['#bench/codebench/live']);
    a.nav.go('#bench');                                   // the tab's button, already there
    a.nav.go('#bench/codebench');
    assert.deepEqual(a.hashes(), ['#bench/codebench/live']);

    const b = started('#livechat');
    assert.deepEqual(b.hashes(), ['#bench/codebench/live']);
    assert.equal(b.nav.current().chat, true, 'the handler can still see it was the live-chat link');

    const c = started('#models/a/b');
    assert.deepEqual(c.hashes(), ['#results/a%2Fb'], 'an old Models link opens, and the address bar takes the Results spelling');
});

test('a hash typed into the address bar is adopted as an entry and drawn once', () => {
    const { nav, typeHash, hashes, drawn, entries, win } = started('#monitor');
    typeHash('#bench/hw');
    assert.deepEqual(hashes(), ['#monitor', '#bench/llama-bench']);
    assert.deepEqual(drawn, ['#monitor', '#bench/llama-bench'], 'popstate and hashchange both fire: one draw');
    assert.equal(entries[1].state.from, '#monitor');
    win.history.back();
    assert.deepEqual(nav.current(), { tab: 'monitor' });
});

test('replace rewrites the current entry and draws; note rewrites it and draws nothing', () => {
    const { nav, hashes, drawn, entries } = started('#bench/codebench/live');
    const id = entries[0].state.nav;
    nav.note('#bench/codebench/live/bat-1');
    assert.deepEqual(hashes(), ['#bench/codebench/live/bat-1']);
    assert.deepEqual(drawn, ['#bench/codebench/live']);
    assert.equal(nav.current().dir, 'bat-1');
    nav.go('#bench/codebench/live/bat-2');
    assert.equal(entries[1].state.from, '#bench/codebench/live/bat-1', 'so Back from the next step returns to what was really showing');
    nav.go('#bench/codebench/queue', { replace: true });
    assert.deepEqual(hashes(), ['#bench/codebench/live/bat-1', '#bench/codebench/queue']);
    assert.equal(drawn[drawn.length - 1], '#bench/codebench/queue');
    assert.equal(entries[0].state.nav, id, 'an entry keeps its id through a rewrite');
});

test('an in-page back button steps back when the parent is the previous entry, and goes there otherwise', () => {
    const a = started('#results');
    a.nav.go('#results/m1');
    a.nav.up('#models');                                  // the old spelling names the same parent
    assert.equal(a.at(), 0, 'the same entry the browser\'s Back lands on');
    assert.deepEqual(a.hashes(), ['#results', '#results/m1'], 'Forward still leads to the model');

    const b = started('#results/m1');                     // a pasted link: nothing of ours to go back to
    b.nav.up('#results');
    assert.deepEqual(b.hashes(), ['#results/m1', '#results']);

    const c = started('#results');
    c.nav.go('#results/m1');
    c.nav.go('#results/m2');                              // a sibling opened from m1's page
    c.nav.up('#results');
    assert.deepEqual(c.hashes(), ['#results', '#results/m1', '#results/m2', '#results'], 'the button says "Results": never m1');
    assert.equal(c.nav.last('#models'), '#results', 'the tab button (still "#models" in script.js) finds the page last shown under Results');

    const onLive = (r) => r.view === 'live' && !r.task;
    const d = started('#bench/codebench/live/bat-1');
    d.nav.go('#bench/codebench/live/bat-1/task-a');
    d.nav.up('#bench/codebench/live', onLive);
    assert.equal(d.at(), 0, 'any Live route without a task is the parent of a finished task');
    assert.equal(d.nav.current().dir, 'bat-1');
});

test('last() is where a tab was left, so its button can return there', () => {
    const { nav } = started('#models');
    assert.equal(nav.last('#bench'), null);
    nav.go('#models/m1/quality');
    nav.go('#bench/codebench/runs/bat-1');
    nav.go('#monitor');
    assert.equal(nav.last('#models'), '#results/m1/quality', 'the old spelling (the tab button) finds the Results page');
    assert.equal(nav.last('#results'), '#results/m1/quality');
    assert.equal(nav.last('#bench'), '#bench/codebench/runs/bat-1');
    assert.equal(nav.last('#bench/codebench'), '#bench/codebench/runs/bat-1');
    assert.equal(nav.last('#bench/sweep'), null);
    assert.equal(nav.last('#mon'), null, 'a prefix ends at a segment');
    nav.go('#models');
    assert.equal(nav.last('#models'), '#results');
});

test('a handler added late is told the current route; one that throws does not stop the others', () => {
    const w = fakeWindow('#history');
    const nav = R.createRouter({ ...w.win, console: { error() {} } });
    const seen = [];
    nav.on(() => { throw new Error('boom'); });
    nav.on((r) => seen.push('early ' + r.tab));
    nav.start();
    nav.on((r, info) => seen.push('late ' + r.tab + ' ' + info.prev));
    assert.deepEqual(seen, ['early history', 'late history null']);
});

test('a handler that redirects does so after every handler has seen the route', () => {
    const w = fakeWindow('#monitor');
    const nav = R.createRouter(w.win);
    const seen = [];
    nav.on((r) => { seen.push('a ' + r.tab); if (r.tab === 'history') nav.go('#models', { replace: true }); });
    nav.on((r) => seen.push('b ' + r.tab));
    nav.start();
    nav.go('#history');
    return Promise.resolve().then(() => {
        assert.deepEqual(seen, ['a monitor', 'b monitor', 'a history', 'b history', 'a models', 'b models']);
        assert.deepEqual(w.hashes(), ['#monitor', '#results']);
    });
});

test('an overlay is an entry under the same URL: Back closes it, closing it steps back, Forward cannot reopen it', () => {
    const { win, nav, hashes, drawn, at } = started('#interactive');
    nav.go('#monitor');
    drawn.length = 0;
    let open = false;
    const close = () => { open = false; nav.overlay('chart', false, close); };
    const show = () => { open = true; nav.overlay('chart', true, close); };

    show();
    assert.deepEqual(hashes(), ['#interactive', '#monitor', '#monitor']);
    win.history.back();
    assert.equal(open, false, 'Back closed it');
    assert.equal(at(), 1);
    assert.deepEqual(drawn, [], 'the page under it is not redrawn');

    win.history.forward();
    assert.equal(open, false);
    assert.equal(at(), 1, 'Forward onto the overlay\'s entry: stays on the page');
    win.history.forward();
    assert.equal(at(), 1, 'every time');

    show();
    close();                                              // ✕ / Esc / backdrop
    assert.equal(at(), 1, 'closing by hand consumes the entry, so the next Back leaves the page as expected');

    show();
    nav.go('#history');                                   // a tab reached with the chart still up
    assert.equal(open, false);
    assert.deepEqual(nav.current(), { tab: 'history' });
    assert.deepEqual(hashes(), ['#interactive', '#monitor', '#history'], 'the page takes the overlay\'s entry: none is left behind it');
    win.history.back();
    assert.deepEqual(nav.current(), { tab: 'monitor' });
    win.history.forward();
    assert.deepEqual(nav.current(), { tab: 'history' }, 'so Forward is never stopped by one');
});

test('reloading with an overlay open steps back to the page under it, once', () => {
    const w = fakeWindow('#interactive');
    w.win.history.replaceState({ nav: 5, from: null }, '', '#interactive');
    w.win.history.pushState({ nav: 6, from: '#interactive' }, '', '#monitor');
    w.win.history.pushState({ nav: 7, from: '#monitor', overlay: 'chart' }, '', '#monitor');
    const nav = R.createRouter(w.win);
    const drawn = [];
    nav.on((r) => drawn.push(r.tab));
    nav.start();
    assert.equal(w.at(), 1);
    assert.deepEqual(drawn, ['monitor']);
    w.win.history.back();
    assert.deepEqual(drawn, ['monitor', 'interactive'], 'and Back from there is an ordinary Back');
});

test('Back restores where the view it returns to was scrolled; a new step does not', () => {
    const views = { monitor: { scrollTop: 0 }, history: { scrollTop: 0 } };
    const { win, nav } = started('#monitor', { scroller: () => views[nav.current().tab] });
    views.monitor.scrollTop = 640;
    nav.go('#history');
    views.monitor.scrollTop = 0;                           // hidden views lose their offset
    views.history.scrollTop = 120;
    win.history.back();
    assert.equal(views.monitor.scrollTop, 640);
    win.history.forward();
    assert.equal(views.history.scrollTop, 120);
    views.history.scrollTop = 0;
    nav.go('#monitor');
    assert.equal(views.monitor.scrollTop, 640, 'left as the view has it');
    assert.equal(views.history.scrollTop, 0);
});

test('without a usable history (an embedded view) navigation still draws', () => {
    const w = fakeWindow('');
    w.win.history.pushState = () => { throw new Error('SecurityError'); };
    w.win.history.replaceState = () => { throw new Error('SecurityError'); };
    const nav = R.createRouter(w.win);
    const drawn = [];
    nav.on((r) => drawn.push(r.tab));
    nav.start();
    nav.go('#bench/sweep');
    nav.go('#models');
    assert.deepEqual(drawn, ['interactive', 'bench', 'models']);
});
