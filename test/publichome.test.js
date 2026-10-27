// The home page's copy as a document (2026-10-07): pages/home.md in the posts repo, edited in the dashboard's post
// editor, rendered into every section shell by public/posts.js. What must hold:
//   - the page renders from the document, through the same markdown renderer as a post;
//   - a missing or unusable document falls back to the built-in text -- the home page is never empty and never throws;
//   - the document is not a post: no list, route or feed knows it;
//   - the editor saves it down the same path as a post (lib/postsrepo.js save -> the GitHub API -> fast-forward).
// Nothing here talks to GitHub or runs git: postsrepo's two ways out (_io.ghApi, _io.run) are replaced.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
const postsDir = path.join(clone, 'posts');
const pagesDir = path.join(clone, 'pages');
const HOME = path.join(pagesDir, 'home.md');
fs.mkdirSync(postsDir); fs.mkdirSync(pagesDir);
process.env.POSTS_DIR = postsDir;
process.env.POSTS_CLONE = clone;
test.after(() => fs.rmSync(clone, { recursive: true, force: true }));
fs.writeFileSync(path.join(postsDir, 'live-post.md'), '---\ntitle: "Live one"\ndate: "2026-10-01"\nsummary: "s"\ndraft: false\n---\n\nbody\n');

const posts = require('../public/posts');
const repo = require('../lib/postsrepo');
const D = posts.HOME_DEFAULT;

const DOC = '---\ntitle: "A new headline <b>&</b> more"\nkicker: "new kicker"\nupdatedAt: 1791400000000\n---\n\nFirst **paragraph** with [a link](/results).\n\nSecond paragraph.\n';
const setHome = (text) => { if (text == null) fs.rmSync(HOME, { force: true }); else fs.writeFileSync(HOME, text); posts.invalidate(); };
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
/** The copy a shell carries, as the browser would read it. */
const carried = (shell) => { const m = /<script id="site-home" type="application\/json">([\s\S]*?)<\/script>/.exec(shell); return m ? JSON.parse(m[1]).html : null; };

test('home: the page renders from the document -- headline and kicker escaped, the intro through marked like a post', async () => {
    setHome(DOC);
    const doc = await posts.homeDoc();
    assert.deepStrictEqual(doc, { kicker: 'new kicker', title: 'A new headline <b>&</b> more', body: 'First **paragraph** with [a link](/results).\n\nSecond paragraph.', updatedAt: 1791400000000, source: 'document' });
    const html = posts.homeHtml(doc);
    assert.match(html, /^<div class="site-kicker">new kicker<\/div><h1 class="site-h1">A new headline &lt;b&gt;&amp;&lt;\/b&gt; more<\/h1><div class="site-lede"><p>First <strong>paragraph<\/strong> with <a href="\/results">a link<\/a>\.<\/p>\s*<p>Second paragraph\.<\/p>\s*<\/div>$/);
    // every section shell carries it (the client can show the overview from any of them), safely inside a script
    for (const p of ['/', '/results', '/writing', '/about']) {
        const shell = await posts.shell({ path: p });
        assert.strictEqual(carried(shell), html, p);
        const raw = /<script id="site-home"[^>]*>([\s\S]*?)<\/script>/.exec(shell)[1];
        assert.ok(!raw.includes('<'), 'no "<" inside the JSON: the copy cannot close the script element');
    }
});

test('home: a script-closing intro cannot break out of the shell', async () => {
    setHome('---\ntitle: "T"\n---\n\nbefore </script><script>alert(1)</script> after\n');
    const shell = await posts.shell({ path: '/' });
    assert.strictEqual((shell.match(/<script id="site-home"/g) || []).length, 1);
    assert.ok(!/<script>alert/.test(shell));
    assert.match(carried(shell), /before/);
});

test('home: a missing document falls back to the built-in text', async () => {
    setHome(null);
    const doc = await posts.homeDoc();
    assert.deepStrictEqual(doc, { ...D, updatedAt: null, source: 'builtin' });
    const html = carried(await posts.shell({ path: '/' }));
    assert.ok(html.includes(`<div class="site-kicker">${D.kicker}</div>`) && html.includes(`<h1 class="site-h1">${D.title}</h1>`));
    assert.match(html, /<a href="\/results">The results<\/a>/);
    fs.rmSync(pagesDir, { recursive: true, force: true }); posts.invalidate();          // no pages/ directory at all
    assert.strictEqual((await posts.homeDoc()).source, 'builtin');
    fs.mkdirSync(pagesDir);
});

test('home: a broken document never renders an empty page and never throws', async () => {
    const builtin = text(posts.homeHtml(D));
    const cases = {
        'an empty file': '',
        'no front matter': 'just some text, no front matter',
        'front matter never closed': '---\ntitle: "X"\n\nbody without the closing line\n',
        'binary junk': '\u0000\u0001��---',
    };
    for (const [name, raw] of Object.entries(cases)) {
        setHome(raw);
        const doc = await posts.homeDoc();
        assert.strictEqual(doc.source, 'builtin', name);
        assert.strictEqual(text(carried(await posts.shell({ path: '/' }))), builtin, name);
    }
    // readable front matter, pieces missing: each missing piece is the built-in one
    setHome('---\ntitle: "Only a headline"\n---\n');
    let html = carried(await posts.shell({ path: '/' }));
    assert.match(html, /<h1 class="site-h1">Only a headline<\/h1>/);
    assert.ok(text(html).includes(text(posts.homeHtml(D)).slice(-60)), 'the built-in intro');
    assert.ok(html.includes(D.kicker), 'no kicker key: the built-in kicker');
    setHome('---\nkicker: "k"\ntitle: 42\n---\n\nAn intro.\n');
    html = carried(await posts.shell({ path: '/' }));
    assert.ok(html.includes(`<h1 class="site-h1">${D.title}</h1>`) && html.includes('<p>An intro.</p>'));
    setHome('---\ntitle: "T"\nkicker: ""\n---\n\n<!-- only a comment -->\n');
    html = carried(await posts.shell({ path: '/' }));
    assert.ok(!html.includes('site-kicker'), 'an empty kicker is allowed: no kicker line');
    assert.ok(text(html).includes('One desktop'), 'an intro with nothing to read is the built-in one');
    // a directory where the file should be, and garbage handed straight to the renderer
    setHome(null); fs.mkdirSync(HOME);
    assert.strictEqual((await posts.homeDoc()).source, 'builtin');
    assert.ok(carried(await posts.shell({ path: '/' })).includes(D.title));
    fs.rmdirSync(HOME);
    for (const junk of [null, undefined, {}, { title: '', body: '', kicker: null }, { title: 7, body: {} }, 'str']) {
        const h = posts.homeHtml(junk);
        assert.ok(/<h1 class="site-h1">[^<]+<\/h1>/.test(h) && text(h).length > 100, JSON.stringify(junk));
    }
    setHome(null);
});

test('home: the document is not a post -- no list, page, feed or editor post list knows it', async () => {
    setHome(DOC);
    fs.writeFileSync(path.join(pagesDir, 'other.md'), '---\ntitle: "OTHER PAGE"\ndraft: false\n---\n\nx\n');
    assert.deepStrictEqual((await posts.index()).map((p) => p.slug), ['live-post']);
    assert.strictEqual(await posts.postPage('home'), null);
    assert.ok(!(await posts.feed()).includes('headline'));
    assert.deepStrictEqual((await repo.listAll()).map((p) => p.slug), ['live-post']);
    assert.strictEqual(await repo.get('home'), null);
    // a post page and the 404 are server-rendered: they never draw the overview, so they do not carry the copy
    assert.strictEqual(carried(await posts.postPage('live-post')), null);
    assert.strictEqual(carried(await posts.notFound()), null);
    fs.rmSync(path.join(pagesDir, 'other.md'));
});

test('home: the text built into site.js is the same text as HOME_DEFAULT', () => {
    // site.js with the document support keeps its last-resort copy in HOME_BUILTIN. public/assets/ is served to the
    // internet straight from disk, so that version waits in public/staged-pubhome/ until Kyle installs it; the site.js
    // serving today has the copy inline in renderOverview. Whichever is in place, its text is HOME_DEFAULT -- which is
    // also what "the page looks the same until the document is edited" means.
    const builtin = (src) => (/const HOME_BUILTIN = `([\s\S]*?)`;/.exec(src) || /el\.innerHTML = `\s*(<div class="site-kicker">[\s\S]*?<\/p>)\s*<div class="stat-row"/.exec(src) || [])[1];
    const files = [path.join(__dirname, '..', 'public', 'assets', 'site.js'), path.join(__dirname, '..', 'public', 'staged-pubhome', 'site.js')].filter((f) => fs.existsSync(f));
    assert.ok(files.length >= 1);
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        const copy = builtin(src);
        assert.ok(copy, `${f}: the built-in home copy`);
        assert.ok(!copy.includes('${'), 'plain text, no interpolation');
        assert.strictEqual(text(copy), text(posts.homeHtml(D)), f);
        for (const href of ['/results']) assert.ok(copy.includes(`href="${href}"`) && posts.homeHtml(D).includes(`href="${href}"`));
        if (f.includes('staged-pubhome')) assert.ok(/const HOME_BUILTIN = /.test(src) && /getElementById\('site-home'\)/.test(src), 'the staged site.js reads the document from the shell');
    }
});

test('home, editor side: the document or the built-in text; serialization round-trips through the public parser', async () => {
    setHome(null);
    assert.deepStrictEqual(await repo.getHome(), { page: 'home', title: D.title, kicker: D.kicker, body: D.body, updatedAt: null, exists: false, builtin: true });
    setHome(DOC);
    assert.deepStrictEqual(await repo.getHome(), { page: 'home', title: 'A new headline <b>&</b> more', kicker: 'new kicker', body: 'First **paragraph** with [a link](/results).\n\nSecond paragraph.', updatedAt: 1791400000000, exists: true, builtin: false });
    const doc = { title: 'He said "hi": ok', kicker: 'a · b: c', body: 'Body\r\n\r\n- a\n\n' };
    const back = posts.parseHome(repo.serializeHome(doc));
    assert.deepStrictEqual([back.title, back.kicker, back.body, back.source], ['He said "hi": ok', 'a · b: c', 'Body\n\n- a', 'document']);
    assert.ok(back.updatedAt > 1790000000000);
    // the built-in text itself, written as a document, reads back as itself
    const d2 = posts.parseHome(repo.serializeHome(D));
    assert.deepStrictEqual([d2.title, d2.kicker, d2.body], [D.title, D.kicker, D.body]);
    assert.strictEqual(posts.homeHtml(d2), posts.homeHtml(D));
});

/** Replace postsrepo's GitHub + git calls; returns the log of what it would have done. */
function fakeIo({ pull = () => '', lsFiles = () => '', status = () => '', checkout = () => '' } = {}) {
    const calls = { gh: [], git: [] };
    repo._io.ghApi = async (args, input) => { calls.gh.push({ args, input: input ? JSON.parse(input) : null }); return args.includes('PUT') ? { commit: { sha: 'abcdef1234567890' } } : { sha: 'oldsha' }; };
    repo._io.run = async (cmd, args) => { calls.git.push([cmd, ...args].join(' ')); if (args.includes('pull')) return pull(calls); if (args.includes('ls-files')) return lsFiles(calls); if (args.includes('status')) return status(calls); if (args.includes('checkout')) return checkout(calls); return ''; };
    return calls;
}

test('home, save: the same path as a post -- one commit through the GitHub API to pages/home.md, then a fast-forward', async () => {
    const calls = fakeIo();
    const out = await repo.save({ page: 'home', title: '  New headline ', kicker: ' k \n k2 ', body: 'Intro **text**.\n', slug: 'ignored', draft: true });
    assert.deepStrictEqual(out, { ok: true, page: 'home', commit: 'abcdef1' });
    assert.deepStrictEqual(calls.gh.map((c) => c.args.join(' ')), [`repos/${repo.REPO}/contents/pages/home.md?ref=main`, `--method PUT repos/${repo.REPO}/contents/pages/home.md --input -`]);
    const put = calls.gh[1].input;
    assert.deepStrictEqual([put.message, put.branch, put.sha], ['Home page: New headline', 'main', 'oldsha']);
    const written = posts.parseHome(Buffer.from(put.content, 'base64').toString('utf8'));
    assert.deepStrictEqual([written.title, written.kicker, written.body], ['New headline', 'k k2', 'Intro **text**.']);
    assert.deepStrictEqual(calls.git, [`git -C ${clone} pull --ff-only --quiet`]);
    // a post still goes where posts go
    const c2 = fakeIo();
    assert.deepStrictEqual(await repo.save({ title: 'A Post', body: 'x', draft: true }), { ok: true, slug: 'a-post', commit: 'abcdef1' });
    assert.strictEqual(c2.gh[1].args.join(' '), `--method PUT repos/${repo.REPO}/contents/posts/a-post.md --input -`);
    assert.strictEqual(c2.gh[1].input.message, 'Draft: A Post');
});

test('home, save: validation -- a headline and an intro are required, and only the home page is a page', async () => {
    const calls = fakeIo();
    await assert.rejects(repo.save({ page: 'home', title: ' ', body: 'x' }), /headline is required/);
    await assert.rejects(repo.save({ page: 'home', title: 'T', body: '  \n' }), /intro text is required/);
    await assert.rejects(repo.save({ page: 'about', title: 'T', body: 'x' }), /unknown page/);
    await assert.rejects(repo.save({ page: '../posts/x', title: 'T', body: 'x' }), /unknown page/);
    assert.deepStrictEqual(calls.gh, [], 'nothing was sent');
    const ok = fakeIo();
    await repo.save({ page: 'home', title: 'T', body: 'x' });           // no kicker: saved as an empty one
    assert.strictEqual(posts.parseHome(Buffer.from(ok.gh[1].input.content, 'base64').toString('utf8')).kicker, '');
});

test('home, save: a local copy that was never committed does not block the fast-forward', async () => {
    // the document starts as a file written into the clone by hand; the first save commits the same path on GitHub
    setHome(DOC);
    let pulls = 0;
    let calls = fakeIo({ pull: () => { if (++pulls === 1) throw new Error('untracked working tree files would be overwritten by merge'); assert.ok(!fs.existsSync(HOME), 'set aside for the pull'); return ''; }, lsFiles: () => '' });
    assert.deepStrictEqual(await repo.save({ page: 'home', title: 'T', body: 'x' }), { ok: true, page: 'home', commit: 'abcdef1' });
    assert.deepStrictEqual(calls.git.map((c) => c.split(' ').slice(3).join(' ')), ['pull --ff-only --quiet', 'ls-files -- pages/home.md', 'pull --ff-only --quiet']);
    assert.deepStrictEqual(fs.readdirSync(pagesDir), [], 'the stale local copy is gone (a real pull has just written the committed one)');
    // a tracked file: the pull failed for another reason -- nothing is moved, the error is reported
    setHome(DOC);
    calls = fakeIo({ pull: () => { throw new Error('could not resolve host'); }, lsFiles: () => 'pages/home.md\n' });
    await assert.rejects(repo.save({ page: 'home', title: 'T', body: 'x' }), /saved to GitHub, but the local clone did not fast-forward: could not resolve host/);
    assert.strictEqual(fs.readFileSync(HOME, 'utf8'), DOC);
    // untracked, and the second pull fails too: the local copy is put back
    calls = fakeIo({ pull: () => { throw new Error('offline'); }, lsFiles: () => '' });
    await assert.rejects(repo.save({ page: 'home', title: 'T', body: 'x' }), /did not fast-forward: offline/);
    assert.strictEqual(fs.readFileSync(HOME, 'utf8'), DOC);
    assert.deepStrictEqual(fs.readdirSync(pagesDir), ['home.md']);
    setHome(null);
});

test('save: uncommitted edits to the saved tracked file do not block the fast-forward; they are kept in .draft-backups', async () => {
    // Kyle 2026-10-15: "error: Your local changes to the following files would be overwritten by merge: posts/what-this-is.md"
    setHome(DOC);
    let pulls = 0;
    let calls = fakeIo({ pull: () => { if (++pulls === 1) throw new Error('Your local changes to the following files would be overwritten by merge'); return ''; },
        lsFiles: () => 'pages/home.md\n', status: () => ' M pages/home.md\n', checkout: () => { fs.writeFileSync(HOME, 'committed'); return ''; } });
    assert.deepStrictEqual(await repo.save({ page: 'home', title: 'T', body: 'x' }), { ok: true, page: 'home', commit: 'abcdef1' });
    assert.deepStrictEqual(calls.git.map((c) => c.split(' ').slice(3).join(' ')),
        ['pull --ff-only --quiet', 'ls-files -- pages/home.md', 'status --porcelain -- pages/home.md', 'checkout -- pages/home.md', 'pull --ff-only --quiet']);
    const bdirs = fs.readdirSync(clone).filter((f) => f.startsWith('.draft-backups-'));
    assert.strictEqual(bdirs.length, 1);
    const kept = fs.readdirSync(path.join(clone, bdirs[0]));
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(clone, bdirs[0], kept[0]), 'utf8'), DOC, 'the local edits are kept');
    // the second pull fails too: the local edits are put back in place
    setHome(DOC);
    calls = fakeIo({ pull: () => { throw new Error('offline'); }, lsFiles: () => 'pages/home.md\n', status: () => ' M pages/home.md\n', checkout: () => { fs.writeFileSync(HOME, 'committed'); return ''; } });
    await assert.rejects(repo.save({ page: 'home', title: 'T', body: 'x' }), /did not fast-forward: offline/);
    assert.strictEqual(fs.readFileSync(HOME, 'utf8'), DOC);
    fs.rmSync(path.join(clone, bdirs[0]), { recursive: true, force: true });
    setHome(null);
});

test('home, preview: the unsaved copy as the site will show it; empty fields show what the site falls back to', () => {
    const html = posts.homePreviewHtml({ title: 'Draft <headline>', kicker: 'k', body: 'An *intro*.' });
    assert.match(html, /HOME PAGE PREVIEW/);
    assert.match(html, /<div class="site-kicker">k<\/div><h1 class="site-h1">Draft &lt;headline&gt;<\/h1><div class="site-lede"><p>An <em>intro<\/em>\.<\/p>/);
    const empty = posts.homePreviewHtml({ title: '', kicker: '', body: '' });
    assert.ok(empty.includes(D.title) && empty.includes('One desktop') && !empty.includes('class="site-kicker"'));
    assert.doesNotThrow(() => posts.homePreviewHtml(null));
    // the post preview is still the post preview
    const post = posts.previewHtml({ title: 'P', date: '2026-10-07', tags: ['a'], body: '**b**', draft: true });
    assert.match(post, /DRAFT PREVIEW — not public/);
    assert.match(post, /<article class="post"><h1 class="post-title">P<\/h1>/);
    assert.match(post, /<strong>b<\/strong>/);
});
