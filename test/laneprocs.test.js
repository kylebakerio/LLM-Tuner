const test = require('node:test');
const assert = require('node:assert');
const { parseSs, laneTrees, parseFdinfo, parseNvApps, pickBuses } = require('../lib/laneprocs');

test('laneprocs: ss output -> pid ports; queue runner trees per lane', () => {
    const ss = [
        'LISTEN 0 4096 127.0.0.1:18089 0.0.0.0:* users:(("python",pid=1190954,fd=7))',
        'LISTEN 0 511 127.0.0.1:18081 0.0.0.0:* users:(("llama-server",pid=1030985,fd=63))',
        'LISTEN 0 4096 [fd7a::1]:8080 [::]:*',
    ].join('\n');
    const byPid = parseSs(ss);
    assert.deepStrictEqual([...byPid.get(1190954)], [18089]);
    assert.deepStrictEqual([...byPid.get(1030985)], [18081]);
    const trees = laneTrees([
        { pid: 10, ppid: 1, cmd: 'python3 tools/queue_runner.py --lane local-gpu ' }, { pid: 99, ppid: 1, cmd: 'grep queue_runner.py --lane <lane>' },
        { pid: 11, ppid: 10, cmd: '/bin/bash sweeps/strata-needle-1m.sh' },
        { pid: 1190954, ppid: 11, cmd: 'python serve/server.py --port 18089' },
        { pid: 20, ppid: 1, cmd: 'python3 tools/queue_runner.py --lane local-3060 ' },
        { pid: 1030985, ppid: 20, cmd: 'llama-server --port 18081' },
    ]);
    assert.deepStrictEqual(trees.get('local-gpu').sort((a, b) => a - b), [10, 11, 1190954]);
    assert.deepStrictEqual(trees.get('local-3060').sort((a, b) => a - b), [20, 1030985]);
});

test('laneprocs: which card a process holds VRAM on (AMD fdinfo, nvidia-smi compute apps)', () => {
    assert.deepStrictEqual(parseFdinfo('pos:\t0\ndrm-driver:\tamdgpu\ndrm-pdev:\t0000:0c:00.0\ndrm-memory-vram:\t7069980 KiB\n'), { bus: '0c:00.0', vramKiB: 7069980 });
    assert.strictEqual(parseFdinfo('drm-driver:\tamdgpu\ndrm-pdev:\t0000:0c:00.0\ndrm-memory-vram:\t0 KiB\n'), null);   // an fd with no VRAM is not "on" the card
    assert.strictEqual(parseFdinfo('pos: 0\nflags: 02\n'), null);
    const nv = parseNvApps('1030985, 00000000:09:00.0, 11440 MiB\n42, 00000000:0A:00.0, 3 MiB\n');
    assert.deepStrictEqual(nv.get(1030985), [{ bus: '09:00.0', vramKiB: 11440 * 1024 }]);
    assert.strictEqual(nv.get(42)[0].bus, '0a:00.0');
    // a multi-backend server's 40 KiB handle on the other card does not put the lane on it
    assert.deepStrictEqual(pickBuses(new Map([['09:00.0', 11440 * 1024], ['0c:00.0', 40]])), ['09:00.0']);
    assert.deepStrictEqual(pickBuses(new Map([['09:00.0', 5e6], ['0c:00.0', 9e6]])), ['09:00.0', '0c:00.0']);   // split across both
    assert.deepStrictEqual(pickBuses(new Map([['0c:00.0', 100]])), ['0c:00.0']);                                  // only a sliver: still the best guess
    assert.deepStrictEqual(pickBuses(new Map()), []);
});
