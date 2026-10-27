#!/usr/bin/env node
// Build the static site and, if what it shows has changed, deploy it (2026-10-06). See STATIC-ARCHITECTURE.md,
// "Publishing". This is the ONLY thing that deploys; build-static.js never does.
//
//   node public/publish-static.js [--dry-run] [--force] [--min-interval-min 120] [--project NAME]
//                                 [--target workers|netlify] [--source URL] [-- <extra args for the deploy tool>]
//
// Target: a Cloudflare Worker with static assets (the default since 2026-10-22: wrangler 4.147 hands every
// `wrangler pages ...` command to Workers, and Workers static assets is Cloudflare's current product):
//   wrangler deploy --config public/wrangler.jsonc --name <pagesProject> --assets public/dist-static --message ...
// The name comes from "pagesProject" in public/site.config.json (or --project) and must be the `name` in
// wrangler.jsonc, which must hold no route or custom domain: run without a terminal (cron), wrangler REPLACES an
// existing DNS record for a custom domain without asking. lab.kylebaker.io is attached once, by hand (step 6g).
// Wrangler is the copy installed in public/node_modules (`npm install` in public/) and needs Node >= 22: this script
// may itself run on an older Node and finds a newer one under ~/.nvm (or WRANGLER_NODE). Needs, once, by Kyle:
// `wrangler login` -- or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
// --target netlify keeps the earlier path: `netlify deploy --prod --dir ...` (NETLIFY_BIN, default `netlify`).
//
// The data comes from public/server.js over HTTP (build-static.js). While pm2 `public` runs, that is it (:3100). Once
// it is stopped (the lab's API is public/live_server.py now), a private copy is started on a free loopback port for
// the build and stopped after, with a Node whose better-sqlite3 opens (PUBLIC_NODE, this one, or one under ~/.nvm):
// under any other Node the catalog quietly loses everything that comes from the database.
//
// It deploys when the build's content hash differs from the last deployed one (public/.static-deployed.json) and
// the last deploy is at least --min-interval-min old. The hash ignores build stamps and the live record, so an
// idle lab produces no deploys. --dry-run builds and reports, and runs nothing. The record also keeps the deployed
// snapshot's stamp and numbers: the dashboard serves them as the lab's /api/stats (lib/publiclive.js).

'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { build, parseArgs } = require('./build-static');
const S = require('./staticsite');

const STATE = path.join(__dirname, '.static-deployed.json');
const WRANGLER_CONFIG = path.join(__dirname, 'wrangler.jsonc');
const DASH = path.join(__dirname, '..');

function nvmNodes() {
    const dir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    try { return fs.readdirSync(dir).map((v) => ({ version: v, path: path.join(dir, v, 'bin', 'node') })).filter((c) => fs.existsSync(c.path)); } catch { return []; }
}

/** A Node that can run wrangler: this one, WRANGLER_NODE, or the newest >= 22 under ~/.nvm. */
function nodeForWrangler() {
    if (process.env.WRANGLER_NODE) return process.env.WRANGLER_NODE;
    return S.pickNode({ version: process.version, path: process.execPath }, nvmNodes());
}

/** A Node that can run public/server.js whole: one whose better-sqlite3 (built for the dashboard's Node) opens a database. */
function nodeForServer() {
    const probe = "new (require('better-sqlite3'))(':memory:').close()";
    const cands = [...new Set([process.env.PUBLIC_NODE, process.execPath, ...nvmNodes().map((c) => c.path).reverse()].filter(Boolean))];
    return cands.find((n) => spawnSync(n, ['-e', probe], { cwd: DASH, stdio: 'ignore', timeout: 15000 }).status === 0) || null;
}

const answers = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** fn(opts) with a public server to read from: opts.source when it answers (or was named: then it is the only choice),
 *  else a private copy of server.js on a free loopback port, stopped when fn is done. */
async function withSource(opts, named, fn) {
    if (named || await answers(`${opts.source}/robots.txt`)) return fn(opts);
    const node = nodeForServer();
    if (!node) throw new Error('pm2 `public` is not running, and no Node here opens better-sqlite3 to run public/server.js for the build (set PUBLIC_NODE)');
    const source = `http://127.0.0.1:${await freePort()}`;
    const child = spawn(node, [path.join(__dirname, 'server.js')], { cwd: DASH, stdio: 'ignore',
        env: { ...process.env, PUBLIC_PORT: source.split(':').pop(), PUBLIC_HOST: '127.0.0.1' } });
    let exited = null;
    child.on('exit', (code, sig) => { exited = code ?? sig; });
    try {
        for (let i = 0; i < 120 && exited === null && !(await answers(`${source}/robots.txt`)); i++) await new Promise((r) => setTimeout(r, 500));
        if (exited !== null) throw new Error(`public/server.js (${node}) exited (${exited}) before it answered`);
        if (!opts.quiet) console.log(`  (pm2 \`public\` is not running: reading from a private copy of public/server.js at ${source}, pid ${child.pid})`);
        return await fn({ ...opts, source });
    } finally { if (exited === null) child.kill('SIGTERM'); }
}

/** public/wrangler.jsonc, checked: the project's name, an assets directory, and no route or custom domain. */
function checkWranglerConfig(project) {
    let wc;
    try { wc = JSON.parse(fs.readFileSync(WRANGLER_CONFIG, 'utf8').replace(/^\s*\/\/.*$/gm, '')); }    // whole-line comments only, in that file
    catch (e) { throw new Error(`cannot read ${WRANGLER_CONFIG}: ${e.message}`); }
    if (wc.name !== project) throw new Error(`${WRANGLER_CONFIG} names the Worker ${JSON.stringify(wc.name)}, site.config.json "pagesProject" says ${JSON.stringify(project)}: make them agree`);
    if (!wc.assets || !wc.assets.directory) throw new Error(`${WRANGLER_CONFIG} has no assets.directory`);
    for (const k of ['route', 'routes']) if (wc[k] != null) throw new Error(`${WRANGLER_CONFIG} has "${k}": a scheduled deploy would attach it, replacing DNS records without asking. Attach a custom domain by hand (STATIC-ARCHITECTURE.md 6g) and keep it out of this file`);
}

async function main() {
    const argv = process.argv.slice(2);
    const dash = argv.indexOf('--');
    const extra = dash >= 0 ? argv.slice(dash + 1) : [];
    const own = dash >= 0 ? argv.slice(0, dash) : argv;
    const flag = (name) => { const i = own.indexOf(name); if (i < 0) return false; own.splice(i, 1); return true; };
    const value = (name, dflt) => { const i = own.indexOf(name); if (i < 0) return dflt; const v = own[i + 1]; own.splice(i, 2); return v; };
    const dryRun = flag('--dry-run'), force = flag('--force');
    const minIntervalMin = Number(value('--min-interval-min', 120));
    const projectArg = value('--project', null);
    const target = value('--target', 'workers');
    if (target !== 'workers' && target !== 'netlify') throw new Error(`--target is workers or netlify (not ${JSON.stringify(target)})`);
    const named = own.some((a) => a === '--source' || a.startsWith('--source=')) || !!process.env.STATIC_SOURCE;

    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'site.config.json'), 'utf8')); } catch { /* none */ }
    const project = projectArg || cfg.pagesProject;
    if (target === 'workers') checkWranglerConfig(project);

    // the build's rule format: Cloudflare's _headers / _redirects (`pages`), or netlify.toml
    const summary = await withSource(parseArgs([...own, '--target', target === 'netlify' ? 'netlify' : 'pages']), named, build);
    let last = {};
    try { last = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* never deployed */ }
    const decision = S.deployDecision({ last, contentHash: summary.contentHash, force, minIntervalMin });

    const wranglerJs = path.join(__dirname, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const node = target === 'workers' ? nodeForWrangler() : null;
    const { cmd, args } = S.deployCommand({
        target, out: summary.out, project, node: node || 'node', wranglerJs, config: WRANGLER_CONFIG,
        netlifyBin: process.env.NETLIFY_BIN || 'netlify', extra,
        message: `snapshot ${new Date(summary.generatedAt).toISOString()} ${summary.contentHash}`,
    });
    const shown = `${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
    if (!decision.deploy) return console.log(`publish: ${decision.why} -- nothing to do${dryRun ? `\n  (a deploy would run, in ${__dirname}: ${shown})` : ''}`);
    if (dryRun) return console.log(`publish: DRY RUN (${decision.why}) -- would run, in ${__dirname}:\n  ${shown}`);

    if (target === 'workers') {
        if (!fs.existsSync(wranglerJs)) throw new Error(`wrangler is not installed: run \`npm install\` in ${__dirname}`);
        if (!node) throw new Error('wrangler needs Node >= 22 and none was found (this is ' + process.version + '): run this script with a newer node, or set WRANGLER_NODE');
    }
    const r = spawnSync(cmd, args, { cwd: __dirname, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS || 'false' } });
    if (r.error) throw new Error(`could not run ${cmd}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`the deploy exited ${r.status} (nothing recorded; the next run tries again)`);
    const tmp = `${STATE}.tmp`;   // whole or not at all: the dashboard reads it every few seconds
    fs.writeFileSync(tmp, JSON.stringify({ target, contentHash: summary.contentHash, at: Date.now(), generatedAt: summary.generatedAt, assetHash: summary.assetHash, stats: summary.stats }) + '\n');
    fs.renameSync(tmp, STATE);
    console.log(`publish: deployed ${summary.contentHash} (${decision.why})`);
}

main().catch((e) => { console.error(`publish-static: ${e.message}`); process.exit(1); });
