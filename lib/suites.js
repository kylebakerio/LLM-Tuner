'use strict';
// --- EXTERNAL BENCHMARK SUITES (EvalPlus, Aider polyglot) ---
// Runs a public coding suite against the model llama-server is currently
// serving, streams its output, and parses the headline score. One suite at a
// time. Both suites talk to an OpenAI-compatible endpoint, so they hit the
// same /v1 the chat does -- no model reload, no special launch.
//   evalplus: pip package; codegen -> evaluate, prints pass@1.
//   aider:    ~/code/suites/aider/benchmark/benchmark.py over the polyglot
//             exercises, run inside its docker image (its README requires it).
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');
const AIDER_DIR = path.join(os.homedir(), 'code', 'suites', 'aider');
const POLYGLOT_DIR = path.join(os.homedir(), 'code', 'suites', 'polyglot-benchmark');
let state = null; let proc = null;
const SUITES = {
    evalplus: {
        label: 'EvalPlus (HumanEval+ / MBPP+)',
        ready: () => !!which('evalplus.codegen'),
        // dataset: humaneval | mbpp ; endpoint: http://127.0.0.1:8080/v1
        cmd: (o) => ['bash', '-lc',
            `set -e; cd ${JSON.stringify(o.workdir)}; export OPENAI_API_KEY=sk-local; ` +
            `evalplus.codegen --model ${JSON.stringify(o.model)} --dataset ${o.dataset} --backend openai --base-url ${JSON.stringify(o.endpoint)} --greedy --root ${JSON.stringify(o.workdir)} ; ` +
            // evaluate wants the .jsonl codegen wrote (a directory is rejected with an AssertionError)
            `S=$(find ${o.workdir} -name '*.jsonl' | head -1); echo "samples: $S"; evalplus.evaluate --dataset ${o.dataset} --samples "$S" 2>&1 | tail -20`],
        parse: (out) => { const m = out.match(/pass@1:\s*([0-9.]+)/gi); return m ? { pass_at_1: m.map(x => parseFloat(x.split(':')[1])) } : {}; },
    },
    aider: {
        label: 'Aider polyglot',
        ready: () => fs.existsSync(path.join(AIDER_DIR, 'benchmark', 'benchmark.py')) && fs.existsSync(POLYGLOT_DIR),
        cmd: (o) => ['bash', '-lc',
            `cd ${JSON.stringify(AIDER_DIR)}; export OPENAI_API_BASE=${JSON.stringify(o.endpoint)} OPENAI_API_KEY=sk-local AIDER_BENCHMARK_DIR=${JSON.stringify(o.workdir)}; ` +
            `docker run --rm -i --network host -v ${JSON.stringify(AIDER_DIR)}:/aider -v ${JSON.stringify(POLYGLOT_DIR)}:/polyglot -v ${JSON.stringify(o.workdir)}:/benchmarks -e OPENAI_API_BASE=http://127.0.0.1:8080/v1 -e OPENAI_API_KEY=sk-local -e AIDER_DOCKER=1 -e AIDER_BENCHMARK_DIR=/benchmarks aider-benchmark bash -lc 'cd /aider && ./benchmark/benchmark.py ${JSON.stringify(o.runName)} --model openai/${o.model} --edit-format ${o.editFormat || 'diff'} --threads ${o.threads || 1} --exercises-dir /polyglot ${o.numTests ? '--num-tests ' + o.numTests : ''} 2>&1'`],
        parse: (out) => { const m = out.match(/pass_rate_\d:\s*([0-9.]+)/g); return m ? { pass_rate: m.map(x => x.trim()) } : {}; },
    },
};
function which(bin) { for (const d of (process.env.PATH || '').split(':').concat([path.join(os.homedir(), '.local', 'bin')])) { try { if (fs.statSync(path.join(d, bin)).isFile()) return path.join(d, bin); } catch {} } return null; }
function list() { return Object.entries(SUITES).map(([id, s]) => ({ id, label: s.label, ready: s.ready() })); }
function start(opts) {
    if (state && state.running) throw new Error('a suite is already running');
    const s = SUITES[opts.suite]; if (!s) throw new Error(`unknown suite ${opts.suite}`);
    if (!s.ready()) throw new Error(`${opts.suite} is not installed/cloned yet`);
    const workdir = path.join(os.tmpdir(), 'lldash-suites', `${opts.suite}-${Date.now()}`); fs.mkdirSync(workdir, { recursive: true });
    const o = { endpoint: 'http://127.0.0.1:8080/v1', model: opts.model || 'local', dataset: opts.dataset || 'humaneval', runName: `lldash-${Date.now()}`, threads: opts.threads, numTests: opts.numTests, editFormat: opts.editFormat, workdir };
    state = { running: true, suite: opts.suite, opts: o, startedAt: Date.now(), finishedAt: null, log: '', result: null, exitCode: null };
    const args = s.cmd(o); proc = spawn(args[0], args.slice(1), { env: { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH}` } });
    const push = (b) => { state.log += b.toString(); if (state.log.length > 400000) state.log = state.log.slice(-300000); };
    proc.stdout.on('data', push); proc.stderr.on('data', push);
    proc.on('close', (code) => { state.running = false; state.exitCode = code; state.finishedAt = Date.now(); state.result = s.parse(state.log); proc = null; });
    return { suite: opts.suite, workdir };
}
function status() { return state ? { ...state, log: state.log.slice(-20000) } : { running: false, idle: true }; }
function stop() { if (proc) { proc.kill('SIGTERM'); return { stopping: true }; } return { running: false }; }
module.exports = { list, start, status, stop };
