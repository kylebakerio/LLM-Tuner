# Public results site (`public/`)

This is an optional, separate process that publishes the model catalog and
results, read-only.

- It never calls the dashboard. It builds what it needs from the same
  libraries, opening the SQLite database read-only.
- It runs under pm2 as `public` (see the
  [README](../README.md#under-pm2)).

## The server

`public/server.js` listens on `PUBLIC_PORT` (default 3100) and `PUBLIC_HOST`
(default all interfaces).

- **Methods:** GET and HEAD only.
- **Allowlist:** it serves an explicit list of files and routes, and answers
  404 for everything else.
- **Pages:** home, results, model pages, writing, about, blog posts and an RSS
  feed.
- **JSON endpoints:** catalog, model, live status and posts.

**What may be published is decided in one place, `lib/publicdata.js`:**

- It drops listed keys wherever they appear. These include credentials,
  personal notes, paths, transcripts and benchmark task content.
- It scrubs every remaining string:
  - absolute paths are cut to their last part;
  - IP addresses are masked;
  - home directories become `~`.
- `test/publicdata.test.js` checks the serialized output.

## Static build

The site can also be built into static files and served from a CDN. Pages then
render from a data snapshot, and can optionally probe a small live API.

```bash
node public/build-static.js            # -> public/dist-static/ (reads the running public server, :3100)
node public/preview-static.js          # local preview on :4173
node public/publish-static.js --dry-run
node public/publish-static.js --force  # deploy with wrangler (Cloudflare Workers static assets)
```

- **What the build reads:** the public server must be running. Otherwise, give
  another source with `--source`.
- **Output:** the build writes to a temporary directory, then swaps it in
  whole.
- **Gates.** The build refuses to finish unless all of these pass:
  - every import resolves;
  - no draft text appears in the output;
  - every payload is already sanitized;
  - a leak scan finds no paths, private addresses or credentials;
  - the output is within the host's file and rule limits.
- **Deploying.** `publish-static.js` deploys only when the content hash has
  changed and the last deploy is old enough. `--force` skips both checks.
  - It needs Node 22+ for `wrangler`.
  - It authenticates with either wrangler's own login, or
    `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`.
- **The live API.** `public/live_server.py` runs under pm2 as `live`, on
  `127.0.0.1:3101`.
  - It is a standard-library Python server.
  - It serves three JSON files that the dashboard writes, already sanitized,
    every 3 s into `../logs/public-api/`.
  - Set `LIVE_CORS_ORIGINS` to the site's origin.
  - A file older than `LIVE_STALE_S` (default 30 s) is answered with `503`.
- **Site settings** are in `public/site.config.json`: links, the analytics id
  and the deploy project name. Replace the committed values with your own.

## Posts

Posts and the text of the home page are markdown files in a separate git
repository.

- **Setup.** Set `POSTS_REPO` (`owner/name`) and `POSTS_CLONE` (the path of the
  local clone).
- **Post files.** Each post is `posts/<slug>.md`, with front matter: `title`,
  `date`, `tags`, `summary` and `draft`.
- **Home page.** The home-page text is `pages/home.md`.
- **What gets published.** Only posts with `draft: false`.
- **Editing.** Use the dashboard's `/posts` editor (see
  [web-ui.md](web-ui.md#posts-editor)). Each save commits one file through
  `gh api`, so no GitHub token passes through Node.
- **Syncing.** The public server pulls the clone every few minutes.
