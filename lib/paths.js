'use strict';
// --- PATH ROOTS (2026-10-13) ---
// dashboard.config.json and the saved profiles used to be absolute paths under one user's home directory, so neither
// could be handed to another machine. A path may now be written three portable ways, and an absolute path means
// exactly what it always did (nothing here touches a string that starts with "/" and holds no "${"):
//
//   ~/llama.cpp/build/bin/llama-server     ~ at the start: this user's home directory
//   ${MODELS}/Qwen3.8-27B-UD-Q4_K_XL.gguf  ${NAME}: a root from dashboard.config.json `pathRoots`, else the
//                                          environment variable of that name. ${MODELS} is `modelsRoot`.
//   Qwen3.8-27B-UD-Q4_K_XL.gguf            a relative MODEL path: under `modelsRoot` (profiles only)
//
// A ${NAME} nothing defines is left as written, so the "not found" message a launch then gives names the variable
// instead of a path that silently lost a segment.
//
//   context(config, { env, home })   -> ctx: the roots of one dashboard.config.json
//   expand(p, ctx)                   -> the path to hand to fs / a child process
//   collapse(p, ctx)                 -> the portable spelling of an absolute path (longest root first, then ~)
//   expandProfile(cfg, ctx)          -> a profile config with its path fields (and raw command) expanded
//   keepPortable(stored, incoming, ctx) -> incoming, with every path field that is just the expansion of what is
//                                          stored put back as stored (a load-and-save does not un-port a profile)
//
// RPC worker `binary` / `logFile` are NOT expanded with this: they are paths on the worker, read by its own shell.
// Pure apart from os.homedir() / process.env defaults. Tested in test/paths.test.js.

const os = require('os');
const path = require('path');

// Profile fields that hold a path on the machine that runs the server. The first three are model files: a relative
// value is looked for under `modelsRoot`.
const MODEL_KEYS = ['modelPath', 'specDraftModel', 'mmprojPath'];
const PROFILE_PATH_KEYS = [...MODEL_KEYS, 'chatTemplateFile', 'strataBase'];
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandWith(p, home, lookup) {
    let s = String(p);
    if (s === '~') s = home; else if (s.startsWith('~/')) s = path.join(home, s.slice(2));
    return s.replace(VAR_RE, (m, name) => { const v = lookup(name); return v == null || v === '' ? m : v; });
}

/** The roots of a parsed dashboard.config.json: `pathRoots` ({ NAME: path }) and `modelsRoot` (also ${MODELS}). */
function context(config, { env = process.env, home = os.homedir() } = {}) {
    const cfg = config && typeof config === 'object' ? config : {};
    const roots = {};
    const raw = cfg.pathRoots && typeof cfg.pathRoots === 'object' && !Array.isArray(cfg.pathRoots) ? cfg.pathRoots : {};
    // a root may be written with ~ or another root / an environment variable; resolved in the order written
    const lookup = (name) => (roots[name] != null ? roots[name] : env[name]);
    for (const [k, v] of Object.entries(raw)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v.trim()) roots[k] = expandWith(v.trim(), home, lookup);
    }
    let modelsRoot = null;
    if (typeof cfg.modelsRoot === 'string' && cfg.modelsRoot.trim()) modelsRoot = expandWith(cfg.modelsRoot.trim(), home, lookup);
    else if (roots.MODELS) modelsRoot = roots.MODELS;
    if (modelsRoot) roots.MODELS = modelsRoot;
    return { home, env, roots, modelsRoot };
}
const NO_ROOTS = () => context({});

function expand(p, ctx) {
    if (typeof p !== 'string' || !p) return p;
    if (p[0] !== '~' && !p.includes('${')) return p;   // every path written before 2026-10-13: untouched
    const c = ctx || NO_ROOTS();
    return expandWith(p, c.home, (name) => (c.roots[name] != null ? c.roots[name] : c.env[name]));
}

/** expand(), and a relative model path is taken under `modelsRoot` (when one is configured). */
function expandModel(p, ctx) {
    const out = expand(p, ctx);
    const c = ctx || NO_ROOTS();
    if (typeof out !== 'string' || !out || !c.modelsRoot) return out;
    return out[0] === '/' || out[0] === '~' || out.startsWith('${') ? out : path.join(c.modelsRoot, out);
}

/** An absolute path in its portable spelling: under the longest root that holds it, else under ~, else as it is. */
function collapse(p, ctx) {
    if (typeof p !== 'string' || p[0] !== '/') return p;
    const c = ctx || NO_ROOTS();
    const under = (dir) => dir && dir !== '/' && (p === dir || p.startsWith(dir.replace(/\/+$/, '') + '/'));
    const named = Object.entries(c.roots).filter(([, dir]) => under(dir)).sort((a, b) => b[1].length - a[1].length)[0];
    if (named) return '${' + named[0] + '}' + p.slice(named[1].replace(/\/+$/, '').length);
    return under(c.home) ? '~' + p.slice(c.home.replace(/\/+$/, '').length) : p;
}

/** ~/ at the start of a word and every defined ${NAME}, in a command line (a profile's rawCommand, a launch_cmd). */
function expandCommand(text, ctx) {
    if (typeof text !== 'string' || (!text.includes('~/') && !text.includes('${'))) return text;
    const c = ctx || NO_ROOTS();
    return text.replace(/(^|[\s'"=])~\//g, (m, pre) => `${pre}${c.home.replace(/\/+$/, '')}/`)
        .replace(VAR_RE, (m, name) => { const v = c.roots[name] != null ? c.roots[name] : c.env[name]; return v == null || v === '' ? m : v; });
}
function collapseCommand(text, ctx) {
    if (typeof text !== 'string' || !text.includes('/')) return text;
    return text.replace(/(^|[\s'"=])(\/[^\s'"]+)/g, (m, pre, p) => pre + collapse(p, ctx));
}

/** A profile config as this machine reads it. Fields that hold no portable spelling are returned as they are. */
function expandProfile(cfg, ctx) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    let out = cfg;
    const set = (k, v) => { if (v !== cfg[k]) { if (out === cfg) out = { ...cfg }; out[k] = v; } };
    for (const k of PROFILE_PATH_KEYS) if (typeof cfg[k] === 'string' && cfg[k]) set(k, MODEL_KEYS.includes(k) ? expandModel(cfg[k], ctx) : expand(cfg[k], ctx));
    if (typeof cfg.rawCommand === 'string') set('rawCommand', expandCommand(cfg.rawCommand, ctx));
    return out;
}

/**
 * A client loads a profile expanded (GET /api/profiles) and saves what it loaded. Where a field it sends back is
 * exactly the expansion of the stored one, the stored spelling stays: a portable profile survives a load-and-save, and
 * a profile stored with absolute paths is never rewritten.
 */
function keepPortable(stored, incoming, ctx) {
    if (!stored || !incoming || typeof stored !== 'object' || typeof incoming !== 'object') return incoming;
    const was = expandProfile(stored, ctx);
    let out = incoming;
    for (const k of [...PROFILE_PATH_KEYS, 'rawCommand']) {
        if (typeof stored[k] === 'string' && stored[k] !== incoming[k] && was[k] === incoming[k]) { if (out === incoming) out = { ...incoming }; out[k] = stored[k]; }
    }
    return out;
}

module.exports = { context, expand, expandModel, collapse, expandCommand, collapseCommand, expandProfile, keepPortable, PROFILE_PATH_KEYS, MODEL_KEYS };
