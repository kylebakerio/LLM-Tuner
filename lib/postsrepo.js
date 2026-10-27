// The WRITE half of the ai lab blog (2026-10-02): the dashboard's post editor (/posts, behind the dashboard's own
// password gate) reads every post including drafts from the local clone of the private repo
// kylebakerio/ai-lab-posts, and saves by committing through the GitHub API -- the earlyroots publish-post.js
// design -- then fast-forwards the clone so the public server (public/posts.js) sees the change.
//
// The GitHub token never passes through this process: `gh api` makes the calls with its own stored login.
//
// The home page's copy (pages/home.md, 2026-10-07) is edited here too: one document that is not a post, read by
// getHome() and written by the same save() -- same validation style, same commit-through-GitHub, same fast-forward.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { parseFrontMatter, parseHome, HOME_DEFAULT } = require('../public/posts');

const REPO = process.env.POSTS_REPO || 'kylebakerio/ai-lab-posts';
const CLONE = process.env.POSTS_CLONE || path.join(os.homedir(), 'code', 'ai-lab-posts');
const POSTS = path.join(CLONE, 'posts');
const HOME_REL = 'pages/home.md';         // beside posts/, never in it: no post list can pick it up
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout))));

async function listAll() {
    let names = [];
    try { names = (await fsp.readdir(POSTS)).filter((f) => /^[a-z0-9-]+\.md$/.test(f)); } catch { return []; }
    const out = [];
    for (const f of names) {
        const { data } = parseFrontMatter(await fsp.readFile(path.join(POSTS, f), 'utf8'));
        out.push({ slug: f.replace(/\.md$/, ''), title: data.title || f, date: String(data.date || ''), draft: data.draft !== false,
            summary: data.summary || '', tags: Array.isArray(data.tags) ? data.tags : [], updatedAt: data.updatedAt || null });
    }
    return out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
}

async function get(slug) {
    if (!SLUG_RE.test(String(slug || ''))) return null;
    try {
        const { data, body } = parseFrontMatter(await fsp.readFile(path.join(POSTS, `${slug}.md`), 'utf8'));
        return { slug, title: data.title || '', date: String(data.date || ''), tags: Array.isArray(data.tags) ? data.tags : [],
            summary: data.summary || '', draft: data.draft !== false, updatedAt: data.updatedAt || null, body };
    } catch { return null; }
}

/** The home page's copy for the editor: the document, or -- while there is none, or it cannot be read -- the text
 *  the site is showing instead (`builtin: true`), so the first save starts from what is on the page. */
async function getHome() {
    let text = null;
    try { text = await fsp.readFile(path.join(CLONE, HOME_REL), 'utf8'); } catch { /* not written yet */ }
    const doc = text == null ? { ...HOME_DEFAULT, updatedAt: null, source: 'builtin' } : parseHome(text);
    return { page: 'home', title: doc.title, kicker: doc.kicker, body: doc.body, updatedAt: doc.updatedAt, exists: text != null, builtin: doc.source !== 'document' };
}

const q = (s) => JSON.stringify(String(s ?? ''));   // a YAML-safe double-quoted string
function serialize(p) {
    return `---\ntitle: ${q(p.title)}\ndate: ${q(p.date)}\ntags: ${JSON.stringify((p.tags || []).map(String))}\nsummary: ${q(p.summary)}\ndraft: ${p.draft !== false}\nupdatedAt: ${Date.now()}\n---\n\n${String(p.body || '').replace(/\r\n/g, '\n').trim()}\n`;
}

function serializeHome(p) {
    return `---\ntitle: ${q(p.title)}\nkicker: ${q(p.kicker)}\nupdatedAt: ${Date.now()}\n---\n\n${String(p.body || '').replace(/\r\n/g, '\n').trim()}\n`;
}

// GitHub calls go through `gh api`, so the token never passes through this process (this machine's gh is 2.4, which
// has no `gh auth token`; `gh api` authenticates itself). -> parsed JSON, or null on 404.
function ghApi(args, input) {
    return new Promise((resolve, reject) => {
        const child = execFile('gh', ['api', ...args], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                if (/HTTP 404|Not Found/i.test(stderr || '')) return resolve(null);
                return reject(new Error((stderr || err.message).trim().split('\n')[0]));
            }
            try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch { resolve({}); }
        });
        if (input != null) { child.stdin.end(input); }
    });
}

const io = { ghApi, run };   // the two ways out of this process; tests replace them (module.exports._io)

/** Fast-forward the clone after a commit made through the API. A copy of the saved path that git does not have blocks
 *  the fast-forward that brings in the commit just made for it: a file written into the clone by hand and never
 *  committed (the home document started that way), or -- Kyle 2026-10-15, "Your local changes to the following files
 *  would be overwritten by merge: posts/what-this-is.md" -- uncommitted edits to a tracked post (drafts revised in the
 *  clone on 10-10). The editor loaded that local text and GitHub now holds what was saved from it, so the local copy is
 *  set aside and the pull tried once more; it is put back if that fails too. An edited tracked file is also copied to
 *  `.draft-backups-<date>/` first and kept there. Other paths are never touched. */
async function pullAfterSave(rel) {
    const pull = () => io.run('git', ['-C', CLONE, 'pull', '--ff-only', '--quiet']);
    const failed = (e) => new Error(`saved to GitHub, but the local clone did not fast-forward: ${e.message}`);
    try { return await pull(); } catch (e) {
        const file = path.join(CLONE, rel);
        let untracked = false;
        try { untracked = fs.existsSync(file) && !(await io.run('git', ['-C', CLONE, 'ls-files', '--', rel])).trim(); } catch { untracked = false; }
        if (!untracked) {
            let dirty = false;
            try { dirty = fs.existsSync(file) && !!(await io.run('git', ['-C', CLONE, 'status', '--porcelain', '--', rel])).trim(); } catch { dirty = false; }
            if (!dirty) throw failed(e);
            const local = await fsp.readFile(file);
            const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
            const keep = path.join(CLONE, `.draft-backups-${stamp}`, `${path.basename(rel, '.md')}.local-${Date.now()}.md`);
            await fsp.mkdir(path.dirname(keep), { recursive: true });
            await fsp.writeFile(keep, local);
            await io.run('git', ['-C', CLONE, 'checkout', '--', rel]);
            try { await pull(); } catch (e2) { await fsp.writeFile(file, local).catch(() => {}); throw failed(e2); }
            return;
        }
        const aside = `${file}.untracked-${Date.now()}`;
        await fsp.rename(file, aside);
        try { await pull(); } catch (e2) { await fsp.rename(aside, file).catch(() => {}); throw failed(e2); }
        await fsp.rm(aside, { force: true });
    }
}

/** Commit one file of the posts repo through the GitHub API, then fast-forward the local clone. -> short commit sha */
async function commitFile(rel, content, message) {
    const route = `repos/${REPO}/contents/${rel}`;
    const cur = await io.ghApi([`${route}?ref=main`]);
    const payload = { message, content: Buffer.from(content).toString('base64'), branch: 'main', ...(cur && cur.sha ? { sha: cur.sha } : {}) };
    const j = await io.ghApi(['--method', 'PUT', route, '--input', '-'], JSON.stringify(payload));
    await pullAfterSave(rel);
    return j && j.commit && j.commit.sha ? j.commit.sha.slice(0, 7) : null;
}

/** Save from the editor: one post -- or, with `page: 'home'`, the home page's copy ({ title, kicker, body }).
 *  -> { ok, slug | page, commit } */
async function save(input) {
    if (input.page !== undefined) {
        if (input.page !== 'home') throw new Error('unknown page');
        const doc = { title: String(input.title || '').trim(), kicker: String(input.kicker ?? '').replace(/\s+/g, ' ').trim(), body: String(input.body || '') };
        if (!doc.title) throw new Error('a headline is required');
        if (!doc.body.trim()) throw new Error('the intro text is required');
        return { ok: true, page: 'home', commit: await commitFile(HOME_REL, serializeHome(doc), `Home page: ${doc.title}`) };
    }
    const slug = String(input.slug || '').trim() || String(input.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!SLUG_RE.test(slug)) throw new Error('slug must be lowercase letters, digits and dashes');
    if (!String(input.title || '').trim()) throw new Error('title is required');
    const post = { title: String(input.title).trim(), date: String(input.date || new Date().toISOString().slice(0, 10)),
        tags: Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
        summary: String(input.summary || '').trim(), draft: input.draft !== false, body: input.body || '' };
    return { ok: true, slug, commit: await commitFile(`posts/${slug}.md`, serialize(post), `${post.draft ? 'Draft' : 'Publish'}: ${post.title}`) };
}

module.exports = { listAll, get, getHome, save, serialize, serializeHome, CLONE, REPO, HOME_REL, _io: io };
