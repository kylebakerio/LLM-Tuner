#!/usr/bin/env node
'use strict';
// Portable spellings for the paths in a saved-profile store (logs/profiles.json), 2026-10-13.
//
// The store keeps absolute paths (/home/<user>/..., /data/models/...) in `modelPath`, `specDraftModel`,
// `mmprojPath`, `chatTemplateFile`, `strataBase` and inside `rawCommand`. Those keep working as they are -- this
// migration is OPTIONAL, for a store that is to be handed to another machine. It rewrites each path that lies under
// a root of dashboard.config.json (`pathRoots`, `modelsRoot`) or under the home directory to `${NAME}/...` or
// `~/...` (lib/paths.js collapse), and leaves every other path alone.
//
//   node tools/migrate-profile-paths.js                       dry run: a report, nothing written
//   node tools/migrate-profile-paths.js --root LLAMA=/abs/dir --models-root /abs/models
//                                                             ... with roots the config does not have yet
//   node tools/migrate-profile-paths.js --write <new file>    also write the migrated store to a NEW file
//
// It never writes the store it read: --write refuses an existing file, and installing the result is a copy the
// owner makes by hand (with the dashboard stopped, and the roots added to dashboard.config.json first -- a profile
// written `${LLAMA}/...` on a machine whose config has no LLAMA root does not launch).
// Every rewritten field is checked to expand back to exactly the original before it is accepted.

const fs = require('fs');
const path = require('path');
const P = require('../lib/paths');

/** doc: a profiles.json document. -> { doc: the migrated copy, changes: [{ profile, field, from, to }], kept: [{ profile, field, value, why }] } */
function migrate(doc, ctx) {
    const out = JSON.parse(JSON.stringify(doc || {}));
    const changes = [], kept = [];
    for (const [name, p] of Object.entries(out.profiles || {})) {
        const cfg = p && p.config;
        if (!cfg || typeof cfg !== 'object') continue;
        for (const k of [...P.PROFILE_PATH_KEYS, 'rawCommand']) {
            const from = cfg[k];
            if (typeof from !== 'string' || !from) continue;
            const to = k === 'rawCommand' ? P.collapseCommand(from, ctx) : P.collapse(from, ctx);
            if (to === from) {
                // still absolute somewhere: say so, so the owner knows what a new machine would have to provide
                const abs = k === 'rawCommand' ? (from.match(/(?:^|[\s'"=])(\/[^\s'"]+\/[^\s'"]+)/g) || []).map((x) => x.replace(/^[\s'"=]/, '')) : (from[0] === '/' ? [from] : []);
                if (abs.length) kept.push({ profile: name, field: k, value: [...new Set(abs)].join('  '), why: 'under no configured root and not under the home directory' });
                continue;
            }
            const back = k === 'rawCommand' ? P.expandCommand(to, ctx) : P.expand(to, ctx);
            if (back !== from) { kept.push({ profile: name, field: k, value: from, why: 'the portable form does not expand back to the same text: left as it is' }); continue; }
            cfg[k] = to;
            changes.push({ profile: name, field: k, from, to });
            // what could not be made portable inside a command that otherwise was
            if (k === 'rawCommand') {
                const rest = (to.match(/(?:^|[\s'"=])(\/[^\s'"]+\/[^\s'"]+)/g) || []).map((x) => x.replace(/^[\s'"=]/, ''));
                if (rest.length) kept.push({ profile: name, field: k, value: [...new Set(rest)].join('  '), why: 'under no configured root and not under the home directory' });
            }
        }
    }
    return { doc: out, changes, kept };
}

function report({ changes, kept }, { profilesFile, ctx, total }) {
    const L = [];
    L.push(`Profile path migration -- DRY RUN REPORT (${new Date().toISOString().slice(0, 10)})`);
    L.push(`store read: ${profilesFile} (${total} profiles; not modified)`);
    L.push(`home: ${ctx.home}`);
    L.push(`roots: ${Object.entries(ctx.roots).map(([k, v]) => `\${${k}} = ${v}`).join(', ') || '(none configured: only ~ applies)'}`);
    L.push('');
    const profiles = new Set(changes.map((c) => c.profile));
    L.push(`${changes.length} field(s) in ${profiles.size} profile(s) would be rewritten; ${kept.length} field(s) keep an absolute path.`);
    L.push('');
    L.push('WOULD CHANGE');
    for (const name of profiles) {
        L.push(`  ${name}`);
        for (const c of changes.filter((x) => x.profile === name)) { L.push(`    ${c.field}`); L.push(`      - ${c.from}`); L.push(`      + ${c.to}`); }
    }
    if (!changes.length) L.push('  (nothing)');
    L.push('');
    L.push('STAYS ABSOLUTE (a new machine needs these paths, or a root that covers them)');
    for (const k of kept) L.push(`  ${k.profile} :: ${k.field}\n      ${k.value}\n      (${k.why})`);
    if (!kept.length) L.push('  (nothing)');
    return L.join('\n') + '\n';
}

function main(argv) {
    const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
    const all = (name) => argv.map((a, i) => (a === name ? argv[i + 1] : null)).filter(Boolean);
    const dash = path.join(__dirname, '..');
    const profilesFile = arg('--profiles') || path.join(dash, '..', 'logs', 'profiles.json');
    const configFile = arg('--config') || path.join(dash, 'dashboard.config.json');
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch { cfg = {}; }
    cfg = { ...cfg, pathRoots: { ...(cfg.pathRoots || {}) } };
    for (const r of all('--root')) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(r); if (!m) throw new Error(`--root wants NAME=/abs/path, got ${r}`); cfg.pathRoots[m[1]] = m[2]; }
    if (arg('--models-root')) cfg.modelsRoot = arg('--models-root');
    const ctx = P.context(cfg);
    const doc = JSON.parse(fs.readFileSync(profilesFile, 'utf-8'));
    const res = migrate(doc, ctx);
    process.stdout.write(report(res, { profilesFile, ctx, total: Object.keys(doc.profiles || {}).length }));
    const out = arg('--write');
    if (out) {
        if (path.resolve(out) === path.resolve(profilesFile)) throw new Error('--write must name a NEW file, not the store that was read');
        if (fs.existsSync(out)) throw new Error(`${out} exists: --write never overwrites`);
        fs.writeFileSync(out, JSON.stringify(res.doc, null, 2));
        process.stdout.write(`\nwrote the migrated store to ${out} (the store that was read is untouched)\n`);
    } else process.stdout.write('\nnothing was written (dry run). --write <new file> writes the migrated store to a new file.\n');
}

if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(1); } }
module.exports = { migrate, report };
