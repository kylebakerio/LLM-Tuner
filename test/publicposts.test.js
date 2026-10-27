// Public blog (public/posts.js): drafts -- and anything not explicitly `draft: false` -- never leave the server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posts-'));
process.env.POSTS_DIR = dir;
fs.writeFileSync(path.join(dir, 'live-post.md'), '---\ntitle: "Live one"\ndate: "2026-10-01"\ntags: ["a", "b"]\nsummary: "s"\ndraft: false\n---\n\n- **bold** bullet\n');
fs.writeFileSync(path.join(dir, 'secret-draft.md'), '---\ntitle: "SECRET DRAFT"\ndate: "2026-10-02"\ndraft: true\n---\n\nsecret body\n');
fs.writeFileSync(path.join(dir, 'no-flag.md'), '---\ntitle: "NO FLAG"\ndate: "2026-10-02"\n---\n\nunflagged body\n');
const posts = require('../public/posts');
const { serialize } = require('../lib/postsrepo');

test('public posts: only draft:false posts are listed, routed and in the feed', async () => {
    const idx = await posts.index();
    assert.deepStrictEqual(idx.map((p) => p.slug), ['live-post']);
    assert.strictEqual(await posts.postPage('secret-draft'), null);
    assert.strictEqual(await posts.postPage('no-flag'), null);
    const page = await posts.postPage('live-post');
    assert.match(page, /<strong>bold<\/strong>/);
    assert.match(page, /og:type" content="article"/);
    const feed = await posts.feed();
    assert.ok(feed.includes('Live one') && !feed.includes('SECRET') && !feed.includes('NO FLAG'));
});

test('editor serialization round-trips through the public parser', () => {
    const text = serialize({ title: 'He said "hi": ok', date: '2026-10-02', tags: ['x', 'y z'], summary: 'one: line', draft: false, body: 'Body\n\n- a' });
    const { data, body } = posts.parseFrontMatter(text);
    assert.strictEqual(data.title, 'He said "hi": ok');
    assert.deepStrictEqual(data.tags, ['x', 'y z']);
    assert.strictEqual(data.summary, 'one: line');
    assert.strictEqual(data.draft, false);
    assert.strictEqual(body.trim(), 'Body\n\n- a');
});
