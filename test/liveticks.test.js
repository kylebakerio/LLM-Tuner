'use strict';
// The sidebar's 1 Hz numbers on the status stream (2026-10-22): server4.js pushes `telemetry` and `lanes` as NAMED
// events, only to a stream opened with ?ticks=1; script.js opens it so and polls only while no tick arrives; the
// clients that read every data: line as a state envelope (dash-cli, lib/sweep.js) never ask for ticks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const server = read('server4.js'), script = read('script.js');

test('server: ticks are named events, written only to ?ticks=1 streams', () => {
    assert.match(server, /const tickFrame = \(event, body\) => `event: \$\{event\}\\ndata: \$\{JSON\.stringify\(body\)\}\\n\\n`;/);
    assert.match(server, /if \(\/\[\?&\]ticks=1\(\?:&\|\$\)\/\.test\(req\.url\)\) \{\s*tickClients\.add\(res\);/);
    assert.match(server, /tickClients\.delete\(res\)/, 'a closed stream leaves the set');
    // the pushes: each telemetry reading, and lanes on a timer that runs only while someone listens
    assert.match(server, /sendTick\('telemetry', lastServerTelemetry\)/);
    assert.match(server, /if \(tickClients\.size\) sendTick\('lanes', lanesLiveAnswer\(\)\)/);
    // the GET and the tick are one answer
    assert.match(server, /res\.end\(JSON\.stringify\(lanesLiveAnswer\(\)\)\)/);
    // nothing else writes a named tick into the shared `clients` list
    assert.ok(!/for \(const \w+ of clients\)[^\n]*event: (telemetry|lanes)/.test(server));
});

test('browser: opens the stream with ticks, listens for every kind it applies, polls only while ticks stop', () => {
    assert.match(script, /new EventSource\('\/api\/status\?ticks=1'\)/);
    assert.match(script, /for \(const kind of Object\.keys\(TICK_APPLY\)\) eventSource\.addEventListener\(kind/);
    assert.match(script, /const TICK_APPLY = \{ telemetry: [^}]+, lanes: [^}]+\};/);
    assert.match(script, /Poll\.every\(\(\) => \(ticksFlowing\(\) \? null : pollLanesLive\(\)\)/);
    assert.match(script, /Poll\.every\(\(\) => \(ticksFlowing\(\) \? null : pollTelemetry\(\)\)/);
    // a hidden tab holds the newest tick instead of drawing it
    assert.match(script, /if \(document\.hidden\) \{ heldTicks\[kind\] = j; return; \}/);
    // no poll left on a bare setInterval / setTimeout chain for these two
    assert.ok(!/setInterval\(pollTelemetry/.test(script));
    assert.ok(!/setTimeout\(pollLanesLive/.test(script));
});

test('dash-cli and the sweep runner never ask for ticks (they read every data: line as state)', () => {
    const cli = read('dash-cli/src/client.js'), sweep = read('lib/sweep.js');
    assert.ok(cli.includes("'/api/status'") && !/ticks=1/.test(cli));
    assert.ok(sweep.includes("path: '/api/status'") && !/ticks=1/.test(sweep));
});

test('index.html loads ui/shared/poll.js before script.js; the public site serves it (util.js imports it)', () => {
    const html = read('index.html');
    const at = (s) => html.indexOf(s);
    assert.ok(at('src="./ui/shared/poll.js"') > 0 && at('src="./ui/shared/poll.js"') < at('src="./script.js"'));
    assert.match(read('public/server.js'), /'ui\/shared\/poll\.js'/);
    assert.match(read('public/staticsite.js'), /'ui\/shared\/poll\.js'/);
});
