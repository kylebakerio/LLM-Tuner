# lab.kylebaker.io as a static site with a live lab behind it

2026-10-06. Target host: **Cloudflare** (Kyle's decision; DNS and the tunnel are already on Cloudflare): since
2026-10-22 a **Worker with static assets**, not Pages (see below). Status: **built and verified on wrangler's local
asset server (`wrangler dev`); the dashboard writes the live files; nothing created on Cloudflare, nothing deployed.**
Nothing here changes the running site until section 6 is done.

**2026-10-22: Workers, not Pages.** Step 6b (`wrangler pages project create lab-kylebaker`) FAILED: wrangler 4.147
hands every `wrangler pages ...` command to Workers ("Delegating to the latest version of Cloudflare Pages, now part of
Cloudflare Workers") and stopped with "Missing entry-point to Worker script or to assets directory". **Nothing was
created** (the account has no Pages project and no Worker named `lab-kylebaker`). Decision: Workers static assets,
Cloudflare's current product, not legacy Pages (`--force`). The build is unchanged (Workers read the same `_headers`
and `_redirects`); the deploy is `wrangler deploy` with `public/wrangler.jsonc`, and a Worker is created by its first
deploy, so there is no "create the project" step any more.

**2026-10-22: a tiny Python server for the lab's API** (Kyle: "tiny python server sounds fine"). The static pages ask
the lab for live status only; `public/live_server.py` (stdlib, ~18 MB) serves it from three JSON files the dashboard
writes every 3 s, and replaces the ~0.72 GiB node `public` process, which can be stopped once the name has moved.
The page no longer takes data from the lab when the lab's is newer: it has none to give (section 2).

**2026-10-22: the two names swapped** (Kyle: "'lab' is cooler and so should be public facing. 'ai' can be my internal
subdomain"). The public site is now **lab.kylebaker.io** (public/server.js, :3100) and **ai.kylebaker.io** is the
private dashboard (server4.js, :3000, behind its password gate); only the tunnel's ingress changed (`kb-ai.yml`). The
Worker is `lab-kylebaker` (it was planned as `ai-kylebaker`). The live API host stays `live.kylebaker.io`. Any zone
setting written for a hostname before the swap (a Cache Rule, a rate-limiting or WAF rule, the Browser Cache TTL note
in step g) was written for the old mapping: check which name it names. **Never move or delete the `ai` record: it is
the private dashboard now.**

Kyle's requirement: *"we need a new architecture for the public page -- it should deploy to e.g. netlify, and connect
to our server _when_ it's up/live, and when not, just show the last record of data it had."*

## What is NOT done, and decisions for Kyle

Done and running (2026-10-22, the `staticlive` install; dashboard restarted, `public` untouched): the dashboard writes
`logs/public-api/{live,running,stats}.json` every 3 s, unprompted; the code and config below are on disk.

Not done (each needs Kyle's Cloudflare login, a DNS or tunnel change, or a restart only he should do):

- no deploy: the Worker `lab-kylebaker` does not exist until step c;
- pm2 `live` (the Python server) is in `ecosystem.config.js` but not started;
- no tunnel or DNS change: `live.kylebaker.io` does not exist; `lab.kylebaker.io` still points at the tunnel and
  `public` on :3100;
- no timer installed for `publish-static.js`;
- not tested against real Cloudflare: everything below was checked on `wrangler dev`, which runs Cloudflare's asset
  server locally (and `wrangler deploy --dry-run`). The custom-domain step and anything the zone's own settings add
  (step g) can only be seen live.

Also waiting, since 2026-10-07 (the question + pass/fail tally on the live cards, and the home page copy as a
document edited in the dashboard's post editor): the server side is on disk but not loaded, and the client side is
not installed. `public/assets/` is served to the internet straight from disk, so the three changed client files
wait in `public/staged-pubhome/` and copying them IS the deploy:

```sh
cd ~/AI/experiment-1/dashboard
cp public/staged-pubhome/{live.js,site.js,site.css} public/assets/   # backups: public/assets/*.bak-pubhome
pm2 restart public                                                   # loads server.js, posts.js, lib/publicdata.js
```

Either half alone changes nothing a visitor can see (checked in a browser both ways). The static build needs both
done first, then an ordinary `node public/publish-static.js --force`.

Decisions:

1. **Worker name and its own URL.** `"pagesProject": "lab-kylebaker"` in `site.config.json` (the key kept its name;
   it is the Worker's name) and `"name"` in `wrangler.jsonc` must agree (publish-static.js checks). The account's
   workers.dev subdomain is `<subdomain>` (`"workersSubdomain"`), so the Worker's own URL is
   **https://lab-kylebaker.<subdomain>.workers.dev**. That subdomain is derived from the account e-mail; it appears
   only in `_headers` (never served), in `site.config.local.json` (gitignored; `site.config.json` until 2026-10-27,
   when it left the repo: `build-static.js` merges the local file over `site.config.json`), and in live_server.py's
   CORS list, which is only echoed back to a page already on that origin. It stays public beside the custom domain as
   a second copy of the site, marked `X-Robots-Tag: noindex` (checked on `wrangler dev` with that Host). To turn it
   off: `"workers_dev": false` in `wrangler.jsonc` before the next deploy.
2. **How often to publish.** Default: at most one deploy every 2 hours, and only when the content changed. Requests
   to static assets are free and unlimited on Workers (Cloudflare's billing page). I found no published limit on how
   often a Worker may be deployed, and did not test one. After a week, lower `--min-interval-min` if you like.
3. **The site's numbers are as of the last deploy.** Stats, the catalog and the model records always come from the
   build; only "what's running now" is live. With the 2-hour default the Results page is up to ~2.5 hours behind
   the lab (`--force` after anything you want out at once).
4. **CORS on the lab** lists `https://lab.kylebaker.io` and the workers.dev URL (live_server.py's default), so the
   second copy shows live status too. To narrow it after go-live, set `LIVE_CORS_ORIGINS` in the `live` entry of
   `ecosystem.config.js` and `pm2 restart live --update-env`.
5. **Launch flags in public data.** `-ngl` appears 1,800 times in the build because the public catalog has always
   carried each config's scrubbed launch command and flags (`test/publicdata.test.js` asserts they are kept). The
   build is byte-for-byte what the live site serves. Keep, unless you want them gone from the live site too
   (a `lib/publicdata.js` change).
6. **API host name**: `live.kylebaker.io` is the build default (`"liveOrigin"` in `site.config.json` changes it).
7. **RSS content type.** Cloudflare serves `feed.xml` as `application/xml`; the home server sends
   `application/rss+xml`. Feed readers accept both; I left it.
8. **The cron's credentials.** It runs on wrangler's OAuth login, which wrangler refreshes itself. If that ever lapses,
   deploys fail (the site keeps the last one). The durable choice is an API token you create (step i).

## 1. Today

One Node process on the home machine (`public/server.js`, pm2 `public`, port 3100) behind the Cloudflare tunnel
`kb-ai` (`lab.kylebaker.io -> 127.0.0.1:3100`; `ai.kylebaker.io` until 2026-10-22, which now reaches the private
dashboard on :3000). It serves everything, so when the machine or the tunnel is down the whole site is down.

| Route | What it returns | Needs | Kind |
|---|---|---|---|
| `/`, `/index.html`, `/live`, `/results`, `/writing`, `/about`, `/models`, `/models/*` | the page shell (`posts.shell()`); `site.js` renders the section in the browser | `site.config.json` | static per deploy |
| `/blog`, `/blog/` | the shell for `/writing` (the client then shows the overview: `site.js` has no `blog` section) | — | static |
| `/blog/<slug>` | the post, rendered on the server with Open Graph tags; 404 for a draft or unknown slug | `~/code/ai-lab-posts/posts/<slug>.md`, `draft: false` only | static per post |
| `/feed.xml`, `/robots.txt` | RSS of published posts; robots | posts | static per post |
| `/blog-images/<file>` | an image from the posts repo's `images/` | posts repo | static |
| `/v/<hash>/ui/...`, `/v/<hash>/assets/...` | the 4 site files + 13 dashboard modules, immutable; `<hash>` covers their mtimes | files on disk | static, versioned |
| `/assets/*`, `/ui/*`, `/vendor/*` | the same files unversioned (`no-cache`; vendor 1 day) | files on disk | static |
| `/api/models/catalog` | every model, config and task result (5.3 MB, 101 models) | `lib/models.listModels()` over the request log, results tree and DB, then `lib/publicdata.sanitizeCatalog()`; cached 3 min | computed |
| `/api/model?key=` | one model's full record (up to 7 MB) | `lib/models.getModel()` + `sanitizePayload()`; cached 1 min | computed |
| `/api/stats` | six headline counts + `generatedAt` | derived from the catalog; cached 3 min | computed |
| `/api/posts` | the list of published posts | `posts.index()` | static per post |
| `/api/live` | busy GPU lanes (card, engine, phase, t/s) and running batteries; since 2026-10-07 each battery may carry `question` (what its queue item answers) and `passed` / `failed` / `excluded` / `remaining` | `logs/public-live.json`, written every 3 s by the dashboard (only while `logs/public-live.want` was fresh, until 2026-10-22) | live |
| `/api/models/running` | running batteries and their current task | the same file | live |
| anything else; any method but GET/HEAD | 404 page; 405 | — | — |

Who calls the API: `assets/site.js` (`/api/stats`, `/api/posts`), `assets/live.js` (`/api/live` every 3 s on the live
page, every 6 s on the overview), and the dashboard's own Models module `ui/models/index.js`, loaded with
`window.PUBLIC_SITE` set (`/api/models/catalog`, `/api/model?key=`, `/api/models/running` every 20 s). All are
same-origin relative `fetch('/api/...')` calls.

## 2. Proposed

```
 browser ──► Cloudflare Worker, static assets (lab.kylebaker.io)      always up
   │           HTML · /v/<hash>/ JS+CSS · posts · snapshot.json · data/*.json
   │
   └──(probe, 2.5 s; then live status)──► Cloudflare tunnel kb-ai ──► home machine (live.kylebaker.io/api/*)
                                            public/live_server.py, 127.0.0.1:3101: three JSON files, CORS for the site
                                                ▲ written every 3 s by the dashboard (lib/publiclive.js)
```

**The static build** (`node public/build-static.js` -> `public/dist-static/`, 142 files, 39.0 MiB, ~5.5 MiB gzipped,
2026-10-22):

- `index.html`, `results.html`, `writing.html`, `about.html`, `404.html` — the same shells `posts.shell()` makes,
  with the asset URLs versioned and one extra script in `<head>`. The section shells carry the home page's copy
  (`#site-home`, rendered from `pages/home.md` in the posts repo, or the built-in text), so an edit to it changes
  `contentHash` and is deployed like a new post: `node public/publish-static.js --force` after saving it;
- `blog/<slug>.html` for published posts only, `feed.xml`, `robots.txt`, `blog-images/` (only images a published post
  uses), and the five icons at the root;
- `v/<hash>/{assets,ui,vendor}/...` — every asset under one **content** hash (the server hashes mtimes; a build has to
  be reproducible). Vendor files are versioned too, so they can be immutable instead of "1 day and hope";
- `snapshot.json` — the manifest the page reads first: `builtAt`, `generatedAt` (the catalog's stamp), `contentHash`,
  the stats and the post list inline, the last live record (what was running, with each item's question and
  passed / failed / left counts as of the build, no rates), and the paths of
  `data/catalog.json` and `data/model/<id>.json` for each model key (101 records; the largest 7.1 MB);
- `_redirects` and `_headers` — the host's rules. Wrangler uploads them as the assets' configuration, never as files
  (`/_headers` is a 404, checked).

**The page** (`assets/static-mode.js`, a classic script loaded before everything else, static build only): it wraps
`window.fetch`. A same-origin `GET /api/...` is answered by it; anything else passes through. This is the hook that
lets `site.js`, `live.js` and the untouched `ui/models/index.js` run unchanged.

1. It starts two things at once: reading `/snapshot.json`, and the probe — one `GET <lab>/api/stats` with a 2.5 s
   timeout, no credentials, no custom headers (so no CORS preflight). The lab is up when that answers 2xx with a
   numeric `generatedAt`.
2. Stats, posts, the catalog and model records come from the snapshot, always, at once: they never wait for the probe.
3. Live status (`/api/live`, `/api/models/running`) waits for the probe (at most 2.5 s). Probe answered: it comes from
   the lab, and the note under the header reads `live — connected to the lab`.
4. Probe failed (refused, timed out, blocked, not JSON, or a 503 because the files are stale): the live panel says the
   lab is offline and shows the last record, the header dot goes grey and the note reads
   `last updated Oct 6, 2026, 3:14 AM — the lab is offline`.
5. A live request that fails later (anything but 2xx) flips the page to offline. While offline the probe is repeated
   at most every 30 s, so the page reconnects by itself (and redraws, `site:refresh`).

| Call | Lab up | Lab down |
|---|---|---|
| `/api/stats`, `/api/posts`, `/api/models/catalog`, `/api/model?key=` | snapshot | snapshot |
| `/api/live`, `/api/models/running` | lab | `{ offline: true, last: ... }` / `{ running: [] }` |

**Why the lab gives no data any more** (2026-10-22). Until then a lab whose catalog stamp was later than the
snapshot's served the catalog and model records too. The Python server has no catalog, and a page that thought the
lab "fresher" would have asked it for one and got a 404 — on every page load if the lab's stamp ran ahead, and in
any tab left open across a deploy that then lost the lab for a moment (every dashboard restart blinks the tunnel).
So static-mode.js no longer compares stamps, and, belt and braces, the lab's `/api/stats` carries the **deployed**
snapshot's `generatedAt` (from `public/.static-deployed.json`; 0 before the first deploy), never a later one.
`contentHash` (a hash of everything the site shows, stamps and the live record removed) is what the publish step
uses to deploy only when something a visitor could see has changed.

**The lab's API** (`public/live_server.py`, pm2 `live`, `127.0.0.1:3101`). Kyle: "tiny python server sounds fine".

- The dashboard (server4.js, the 3 s public-live tick, `lib/publiclive.js`) writes `logs/public-api/live.json`,
  `running.json` and `stats.json` — each through a temp file and a rename — in exactly the shape `public/server.js`
  answered `/api/live` and `/api/models/running` with (`liveRunning` + `sanitizePayload`, models named from the
  catalog; checked equal on the running system, `at`/`stale` aside). It does this **unprompted**: it used to write
  only while `public` had touched `logs/public-live.want`; a file server has no write path. It still writes
  `logs/public-live.json`, which `public/server.js` (and the build's private copy of it) reads.
- The server: GET/HEAD; `/api/stats`, `/api/live`, `/api/models/running` (query strings ignored) map to those three
  files and every other path is a 404; `Cache-Control: no-store`; a file older than 30 s is a **503** (the dashboard
  stopped writing), which the page reads as offline; binds 127.0.0.1 only; no Python version in `Server:`; no log line
  per request. Other methods get Python's 501.
- CORS: the request's `Origin` is echoed (with `Vary: Origin`) when it is in the list —
  `https://lab.kylebaker.io` and `https://lab-kylebaker.<subdomain>.workers.dev` by default, `LIVE_CORS_ORIGINS`
  (comma separated) to change it; never `Access-Control-Allow-Credentials`. Simple GETs only: the page never preflights.
- `site.config.json` `"corsOrigins"` (public/liveapi.js) is `public/server.js`'s, which serves no API to the static
  site any more; leave it unset.

**URLs on Cloudflare** (checked on `wrangler dev` with `html_handling: "auto-trailing-slash"`,
`not_found_handling: "404-page"`; the rules are in `staticsite.js`, `redirectRules`):

- `results.html` is served at `/results` by the asset server itself; `/results.html`, `/results/`, `/index.html` and
  `/blog/<slug>.html` are **307**s to the clean URL (Pages answered 308). So the four pages and the post pages need no
  rule, and must not have one: a redirect rule is followed even when a file exists, so `/x -> /x.html 200` loops.
- `_redirects` has six lines: `/live` and `/live/` -> `/` (302; its own page until 2026-10-10), `/blog` and `/blog/`
  -> `/writing` (301; a rule matches its path exactly), `/models` and `/models/*` -> `/results` (200: the results page
  at the requested URL, as `server.js` does). The lab's API is never proxied through Cloudflare's assets — the browser
  calls it directly.
- Unknown paths get `404.html` with status 404. There is no `/api/` on the static host: `/api/stats` is a 404.

**Headers** (`_headers`, 16 rules):

- `/*`: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, and the
  `Content-Security-Policy` — the one `server.js` sends today plus the lab's origin in `connect-src`. Without that the
  browser blocks the probe.
- `/v/*`: `Cache-Control: public, max-age=31536000, immutable`.
- pages, `/snapshot.json`, `/data/*`, `/feed.xml`: `Cache-Control: public, max-age=0, must-revalidate` — the asset
  server's default too, written out so it does not depend on the default. Every answer has an `ETag`; a repeat request
  is a 304 (checked).
- When two rules match a path and set the same header, the values are joined with a comma. No header is named by
  two rules that can match one path (there is a test for that).
- `https://lab-kylebaker.<subdomain>.workers.dev/*`: `X-Robots-Tag: noindex`, for the copy at the Worker's own name
  (built from `pagesProject` + `workersSubdomain`; on `wrangler dev` it applied with that Host and not with
  `Host: lab.kylebaker.io`).
- Differences from Pages seen on `wrangler dev`: the 404 page is sent with `max-age=0, must-revalidate` (Pages:
  `no-store`), and `_headers` rules also apply to redirects (the CSP on every 30x, `Cache-Control` on `/blog/`). Neither
  matters here.

**Limits** (Cloudflare's docs, read 2026-10-22; Workers Free plan; the build fails if it would exceed one):

| Limit | Docs | This build |
|---|---|---|
| asset files per Worker version | 20,000 (Paid: 100,000) | 140 (+ `_headers`, `_redirects`) |
| size of one file | 25 MiB | 7.1 MB (the largest model record) |
| `_headers` | 100 rules, 2,000 characters per line | 16 rules |
| `_redirects` | 2,000 static + 100 dynamic, 1,000 characters per line | 5 static + 1 dynamic |
| requests to static assets | free and unlimited | — |

**Refreshing the snapshot** (`node public/publish-static.js`): build, then
`wrangler deploy --config public/wrangler.jsonc --name lab-kylebaker --assets public/dist-static --message "snapshot ..."`
if `contentHash` differs from the last deployed one and the last deploy is at least `--min-interval-min` (120) old.
After a deploy it records `{ contentHash, at, generatedAt, assetHash, stats }` in `public/.static-deployed.json`
(the dashboard serves that `generatedAt` and those stats as the lab's `/api/stats`).

- The build reads data over HTTP from `public/server.js`: the bytes the public site serves, already scrubbed. While
  pm2 `public` runs that is it (127.0.0.1:3100, 1–10 s). **Once `public` is stopped** (step h), publish-static.js
  starts a private copy of `public/server.js` on a free loopback port for the build and stops it after (~0.7 GB for
  10–20 s; checked: 142 files, 101 models, the same as from `public`). It must run on a Node whose better-sqlite3
  opens — under Node 22 the catalog quietly loses everything from the database (79 models instead of 101) — so the
  script picks one (`PUBLIC_NODE`, its own, or one under `~/.nvm`) and refuses if none. Run it with the dashboard's
  Node (20.20.2, the default `node`); it finds Node 22 under `~/.nvm` for wrangler by itself.
- The server answers from cache and refreshes in the background, so a first answer can be old; the build asks once,
  waits for a catalog stamp under 4 minutes old, and reads the model records on a second pass.
- Trigger: a timer every 30 minutes; the script itself holds back to one deploy per 2 hours. While benchmarks run
  the request counts move constantly, so expect a deploy each interval; an idle lab deploys nothing. After publishing
  a post, or before a planned shutdown: `node public/publish-static.js --force`. An unplanned shutdown leaves a
  snapshot at most one interval old.
- Wrangler uploads only files Cloudflare doesn't already have (typically `snapshot.json`, the catalog and a few
  model records). It is installed in `public/node_modules` (`public/package.json`, 221 MB) and needs Node >= 22.
- **No route or custom domain in `wrangler.jsonc`, ever.** Run without a terminal (cron), wrangler replaces an existing
  DNS record for a custom domain without asking (`override_existing_dns_record`, in its deploy code). publish-static.js
  refuses to deploy a config with `route`/`routes`. A deploy with no route leaves an attached domain alone.
- `--target netlify` keeps the Netlify path (`netlify.toml` or, with `--rules files`, the same two files with
  Netlify's rule set; `netlify deploy --prod`). Not the default and not tested against Netlify.

**Posts and drafts.** The build takes posts from `public/posts.js`, which only returns `draft: false` posts — the
same rule the live site uses. Two more checks fail the build: an independent read of every `.md` file's front matter
must agree with `posts.js` about what is published, and no unpublished slug may appear as a page, in the feed, in
any HTML link or in `snapshot.json`. Images are copied only if a published post references them (the live server
serves any file in `images/` by name; the static site is stricter). Unpublishing a post takes effect at the next deploy.

**Security.**

- The lab exposes less than today: three GET-only JSON files instead of six computed routes, from a process with no
  logic and no write path, on loopback, behind the tunnel's `path: ^/api/`. The data is what `/api/live` already
  served, through the same `lib/publicdata.js` scrubbing.
- CORS is a browser rule about which pages may read the answers, not access control; the data is public either way.
  No cookies exist and credentials are never allowed cross-origin.
- The build re-checks what it is given: every payload must be unchanged by `sanitizePayload()`, and every output
  file is scanned for home/model-store/HF-cache paths, private and tailnet addresses, the host name, and (data files)
  any key in `publicdata.DROP_KEYS` or the word "password". Any hit fails the build and the previous output stays.
- Rate limiting: one Cloudflare rate-limiting rule on host `live.kylebaker.io` (the free plan allows one; e.g. 50
  requests per 10 s per IP — one viewer makes about 2 every 3 s). Each answer is a file read; not built in.
- The static site moves load off the home machine: visitors who only read never touch it beyond one small probe and
  the live polls.

## 3. Files

| File | What |
|---|---|
| `public/staticsite.js` | the pure half: asset list and hash, route -> file list, redirect and header rules per host, limits, manifest, content hash, deploy decision and command (`wrangler deploy`), draft and leak gates |
| `public/build-static.js` | the build (`--out`, `--target pages\|netlify`, `--source`, `--live-origin`, `--no-analytics`, `--quiet`); writes `dist-static/` whole or not at all. `pages` = Cloudflare's `_headers` / `_redirects`, for Workers too |
| `public/publish-static.js` | build + deploy-if-changed (`--dry-run`, `--force`, `--min-interval-min`, `--project`, `--target workers\|netlify`, `--source`). The only thing that deploys; starts a private `server.js` for the build when `public` is down |
| `public/wrangler.jsonc` | the Worker: name, assets directory, `auto-trailing-slash`, `404-page`, `workers_dev: true`, `preview_urls: false`; never a route |
| `public/live_server.py` | the lab's API: three JSON files from `logs/public-api/` (pm2 `live`, :3101) |
| `lib/publiclive.js` | the dashboard side: the raw live snapshot -> those three files, written atomically (server4.js calls it every 3 s) |
| `public/preview-static.js` | a dependency-free model of the host for quick checks on any Node (`--dir`, `--port`, `--host`, `--target`) |
| `public/package.json`, `package-lock.json`, `node_modules/` | wrangler 4.147.0, for `wrangler dev` and the deploy |
| `public/liveapi.js` | `server.js`'s CORS allow-list (unused by the static site since 2026-10-22) |
| `public/assets/static-mode.js`, `static.css` | the page's data layer and status note (static build only) |
| `test/staticsite.test.js`, `test/staticmode.test.js`, `test/liveapi.test.js`, `test/publicliveapi.test.js` | 21 + 12 + 5 + 5 tests (`publicliveapi` starts live_server.py on a free port) |

`.gitignore` has `public/dist-static/`, `public/.static-deployed.json`, `public/.wrangler/`, `public/.netlify/`.
Changed 2026-10-22 (each with a `.bak-1022-staticlive` copy; install script and log in
`../dashboard-stage-staticlive-1022/`): server4.js, static-mode.js, staticsite.js, build-static.js, publish-static.js,
preview-static.js, public/package.json, site.config.json (`"workersSubdomain"`), ecosystem.config.js (pm2 `live`),
the two tests. `public/server.js` was not touched.

## 4. Not changed, and the hook that would be cleaner

`ui/**` and the dashboard's `script.js` were not touched. The fetch wrapper exists because `ui/models/index.js`
calls `fetch('/api/...')` itself. If that module is opened up later, two small changes would let the wrapper go:

- in `api()` (index.js line ~35): use `window.PUBLIC_API ? window.PUBLIC_API(url) : fetch(url)`, so the public site
  passes its data source in instead of replacing `fetch`;
- listen for a `models:reload` event and call `load(true)` when the overview is showing, so the Results page picks
  up the lab coming back without a navigation (today it does on the next model open or page load).

## 5. Local preview

On Cloudflare's own asset server (needs Node >= 22; no login, no account):

```sh
cd ~/AI/experiment-1/dashboard/public
node build-static.js                                           # -> dist-static/  (lab API https://live.kylebaker.io)
PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH npx wrangler dev --port 4174 --ip 127.0.0.1
```

With the production lab origin this shows the **offline** mode until step e is done. To see both modes without
touching pm2, run the Python server by hand on another port and build against it:

```sh
SC=$(mktemp -d)
LIVE_PORT=3191 LIVE_CORS_ORIGINS=http://127.0.0.1:4174 python3 live_server.py &         # the "lab" (reads logs/public-api/)
node build-static.js --live-origin http://127.0.0.1:3191 --no-analytics --out $SC/dist-static
PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH npx wrangler dev --assets $SC/dist-static --port 4174 --ip 127.0.0.1
# stop the 3191 process (kill its PID): an open page turns offline within a poll; start it again: live within 30 s
```

Checked this way on 2026-10-22 (with the real static-mode.js in Node, as no browser on this machine could reach
loopback): lab up -> probe up, live status from :3191, everything else from the build; lab gone -> offline with the
last record; the CORS answer named only the listed origin. From another machine on the tailnet use the tailnet
address for all of them (`LIVE_CORS_ORIGINS`, `--live-origin`, `--ip`; live_server.py itself binds 127.0.0.1 only, so
a tailnet test needs a forward or a temporary copy). `node preview-static.js` (port 4173) is the quick version on
any Node: same pages, statuses, redirects and headers on every route I compared, except it answers 308 where Workers
answer 307, puts `Cache-Control` on the 308 for `/live/`, sends no body with a 301, and types `feed.xml` as
`application/rss+xml` where Cloudflare says `application/xml`.

## 6. Go-live runbook, in order

I did not deploy, create anything on Cloudflare, touch DNS or the tunnel, or start `live`. Each step says what you
should see and how to undo it. The site keeps running from the home server until step g, and `public` keeps running
until step h, so until then every step is undone without anyone noticing. Run everything as kyle, from
`~/AI/experiment-1/dashboard` unless it says `public/`.

```sh
# a. DONE 2026-10-22: wrangler is logged in (OAuth).
cd ~/AI/experiment-1/dashboard/public
PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH npx wrangler whoami   # expect: <account-email>'s Account, <account-id>

# b. Nothing to create. The Pages project from the old step b was never created (the command failed; the account has
#    no Pages project and no Worker named lab-kylebaker). A Worker is created by its first deploy.
```

```sh
# c. First deploy, to the workers.dev URL only (lab.kylebaker.io is untouched: the config has no route).
cd ~/AI/experiment-1/dashboard
node public/publish-static.js --force          # the default node (20.20.2); it runs wrangler on Node 22 itself
#    expect: the build summary ("142 files ... gates passed ..."), then wrangler: "Uploaded lab-kylebaker",
#    ~140 new assets, "Deployed lab-kylebaker triggers" with https://lab-kylebaker.<subdomain>.workers.dev,
#    a "Current Version ID", then "publish: deployed <hash> (forced)".
#    Within 3 s the lab's stats file carries the deployed stamp:
cat ../logs/public-api/stats.json              # {"models":101,...,"generatedAt":<the snapshot's>}  (was {"generatedAt":0})
#    If wrangler asks to register a workers.dev subdomain: it should not (the account has <subdomain>); answer no
#    and tell me.
#    Undo: cd public && npx wrangler delete lab-kylebaker   (deletes the Worker; nothing public used it), then
#    rm public/.static-deployed.json
```

```sh
# d. Check it on the workers.dev URL (the same checks passed on `wrangler dev`, 2026-10-22)
P=https://lab-kylebaker.<subdomain>.workers.dev
curl -sI $P/                       | grep -i 'HTTP/\|cache-control\|x-robots'                 # 200; max-age=0, must-revalidate; x-robots-tag: noindex
curl -sI $P/ | grep -io 'connect-src[^;]*'                                                    # ... 'self' https://live.kylebaker.io ...
curl -sI $P/v/$(ls public/dist-static/v)/assets/site.js | grep -i 'HTTP/\|cache-control'      # 200; public, max-age=31536000, immutable
curl -sI $P/snapshot.json          | grep -i 'HTTP/\|cache-control'                           # 200; max-age=0, must-revalidate
curl -sI $P/models/x               | grep -i 'HTTP/'                                           # 200 (the results page)
curl -sI $P/blog                   | grep -i 'HTTP/\|location'                                # 301 -> /writing
curl -sI $P/live                   | grep -i 'HTTP/\|location'                                # 302 -> /
curl -sI $P/results.html           | grep -i 'HTTP/\|location'                                # 307 -> /results  (Pages said 308)
for u in /nope /api/stats /_headers; do curl -s -o /dev/null -w "$u %{http_code}\n" $P$u; done  # 404 each
#    In a browser: the site, with "last updated <time> — the lab is offline" and a grey dot (live.kylebaker.io does
#    not exist yet). Results and model pages work from the snapshot.
#    Undo: as c. A bad later deploy: cd public && npx wrangler rollback  (to the previous version; asks which).
```

```sh
# e. The lab's API host: the Python server, then the tunnel.
pm2 start ecosystem.config.js --only live && prlimit --pid $(pm2 pid live) --core=0:unlimited
curl -s 127.0.0.1:3101/api/stats; echo                         # {"models":101,...,"generatedAt":<deployed>}
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3101/         # 404
pm2 save    # so pm2-kyle.service brings `live` back after a reboot. NOTE: this saves every app's current state; the
            # last save was 2026-10-15 (stopped queue lanes etc. are saved as they are now). Skip it if that matters.
#    Add to ~/.cloudflared/kb-ai.yml, above the final `- service: http_status:404`:
#      - hostname: live.kylebaker.io
#        path: ^/api/
#        service: http://127.0.0.1:3101
cloudflared tunnel route dns kb-ai live.kylebaker.io           # expect: "Added CNAME live.kylebaker.io which will route to this tunnel tunnelID=<tunnel-id>"
#    Restart the tunnel: the dashboard's Remote access toggle, off and on (ai. and lab. blink for a few seconds), then
pgrep -af kb-ai.yml                                            # one cloudflared ... --config .../kb-ai.yml run
curl -s https://live.kylebaker.io/api/live | head -c 200; echo   # {"at":...,"lanes":[...],"running":[...],"stale":false}
curl -s -o /dev/null -w '%{http_code}\n' https://live.kylebaker.io/          # 404: only /api/ is exposed on this name
curl -sI https://live.kylebaker.io/api/live | grep -i 'cache-control\|cf-cache-status'   # no-store; DYNAMIC or none. A HIT: add a Cache Rule "bypass" for live.kylebaker.io
#    Optional: one rate-limiting rule on host live.kylebaker.io (e.g. 50 requests / 10 s / IP).
#    Undo: pm2 stop live (or pm2 delete live); remove the three ingress lines and restart the tunnel; delete the
#    `live` CNAME in the dashboard (DNS -> Records). Nothing public used it yet.
```

```sh
# f. CORS: nothing to configure (live_server.py's default list is lab.kylebaker.io + the workers.dev URL). Check:
for o in https://lab-kylebaker.<subdomain>.workers.dev https://lab.kylebaker.io https://example.com; do
  curl -sI -H "Origin: $o" https://live.kylebaker.io/api/stats | grep -i '^HTTP/\|access-control-allow-origin'
done
#    expect: 200 + access-control-allow-origin: <that origin> for the first two; 200 and NO allow-origin for example.com
#    Reload https://lab-kylebaker.<subdomain>.workers.dev : the note reads "live — connected to the lab", the dot is
#    green, the overview shows what is running. Stop here if anything is off: nothing public has changed yet.
#    Undo / narrow: set env LIVE_CORS_ORIGINS in the `live` entry of ecosystem.config.js, then
#    pm2 restart live --update-env  (the page reads a missing header as "offline"; nothing breaks).
```

**g. Move the name** (the only step visitors can notice). `lab.kylebaker.io` is a proxied CNAME to the kb-ai tunnel;
`ai.kylebaker.io` and now `live.kylebaker.io` point at the same tunnel and must stay there. Cloudflare's docs say a
Workers Custom Domain cannot be created on a hostname that has a CNAME, so the tunnel record has to go; wrangler can
replace it in one API call, which is the shortest outage. Do it right after a publish, so the version it deploys is
the current build (`node public/publish-static.js --force` first if unsure).

1. **Shortest (one call):** in a terminal (it must be able to ask you):

   ```sh
   cd ~/AI/experiment-1/dashboard/public
   PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH npx wrangler deploy --domain lab.kylebaker.io
   ```

   Expect a prompt "You already have DNS records that conflict for these Custom Domains: • lab.kylebaker.io  Update
   them to point to this script instead?" — answer **y**; then "Deployed lab-kylebaker triggers" listing
   `lab.kylebaker.io (custom domain)` and the workers.dev URL (`workers_dev: true` keeps it). Wrangler's login can read
   the zone but not edit DNS; if Cloudflare refuses the replacement for that reason, wrangler says so, nothing has
   changed, and you use 2. Do NOT put `--domain` in `wrangler.jsonc` or in the cron: without a terminal wrangler
   replaces DNS records without asking (publish-static.js refuses a config with a route).
2. **Dashboard (a gap of about a minute):** open two tabs: DNS -> Records for kylebaker.io, and Workers & Pages ->
   `lab-kylebaker` -> Settings -> Domains & Routes -> Add -> Custom domain. Delete the `lab` CNAME (the tunnel one;
   NOT `ai`, NOT `live`), then at once add `lab.kylebaker.io` in the other tab. Between the delete and the new record
   the name does not resolve.
3. Either way Cloudflare may take a minute or two to issue the domain's certificate; wait for it to show **Active**,
   then:

```sh
P=https://lab.kylebaker.io
curl -sI $P/ | grep -i 'HTTP/\|cache-control\|x-robots'                 # 200; max-age=0, must-revalidate; NO x-robots-tag
curl -sI $P/ | grep -io 'connect-src[^;]*'                               # includes https://live.kylebaker.io
curl -sI $P/snapshot.json | grep -i 'cache-control\|cf-cache-status'     # must be max-age=0, must-revalidate
curl -sI $P/v/$(ls dist-static/v)/assets/site.js | grep -i cache-control # immutable
curl -sI $P/api/stats | grep -i '^HTTP/'                                 # 404: the API is only on live.kylebaker.io now
```

   `snapshot.json` is the one to look at: the name is now served through your zone, and `server.js` records that the
   zone once turned a `no-cache` into a 31-day browser cache. If its `Cache-Control` is not the one above, set the
   zone's Browser Cache TTL to "Respect Existing Headers" (or a Cache Rule for host `lab.kylebaker.io`). A cached
   snapshot is the one thing that would quietly defeat this design. In a browser: "live — connected to the lab".
4. Leave the `lab.kylebaker.io` ingress line in `kb-ai.yml` and leave `public` running for now: with no DNS record
   pointing at it the line serves nobody, and together they make the rollback two commands.

   **Undo:** Workers & Pages -> `lab-kylebaker` -> Settings -> Domains & Routes -> `lab.kylebaker.io` -> Remove, then
   at once `cloudflared tunnel route dns --overwrite-dns kb-ai lab.kylebaker.io` (the CNAME points at the tunnel again;
   `public` serves the full site as before). Deleting a Custom Domain does not delete its certificate (SSL/TLS -> Edge
   Certificates; harmless, or delete it there). Don't flip back and forth; decide, then move.

```sh
# h. Stop `public` (after a day or so of the site working from Cloudflare): ~0.75 GB back.
pm2 stop public                        # stop, not delete: the entry stays for a rollback
#    expect: lab.kylebaker.io unaffected (Cloudflare), live.kylebaker.io unaffected (Python), and the next build
#    reads from a private copy:
node public/publish-static.js --dry-run
#      (pm2 `public` is not running: reading from a private copy of public/server.js at http://127.0.0.1:<port>, pid <n>)
#      static site (Cloudflare): 142 files ... 101 models ...   gates passed ...   <- the same model count as before
#      publish: ... -- nothing to do  (or: DRY RUN ... would run ...)
#    pm2 save   (if you saved in e: otherwise a reboot resurrects `public` from the old dump; harmless, just memory)
#    Undo: pm2 start public && prlimit --pid $(pm2 pid public) --core=0:unlimited. Rolling the NAME back (g's undo)
#    needs `public` running first. Later, once you're sure, the lab.kylebaker.io lines can leave kb-ai.yml
#    (tunnel restart) and `public` can be `pm2 delete`d.
```

```sh
# i. Keep it fresh: crontab -e   (absolute paths: cron has a bare PATH. The dashboard's Node 20 runs the script and
#    the private server.js; the script finds Node 22 under ~/.nvm for wrangler.)
*/30 * * * * cd /home/kyle/AI/experiment-1/dashboard && /home/kyle/.nvm/versions/node/v20.20.2/bin/node public/publish-static.js --quiet >> /home/kyle/AI/experiment-1/logs/public-publish.log 2>&1
#    expect in the log, every 30 min, one of:
#      publish: unchanged since the last deploy (<hash>) -- nothing to do
#      publish: changed, but the last deploy was N min ago (< 120) -- nothing to do
#      ... wrangler's upload and "Deployed lab-kylebaker triggers" ... publish: deployed <hash> (changed (<old> -> <new>))
#    and nothing else (no prompt can appear: no route in the config, the workers.dev subdomain exists).
#    Credentials: it uses wrangler's OAuth login, refreshed by wrangler. For something that cannot lapse, create an
#    API token (My Profile -> API Tokens -> "Edit Cloudflare Workers" template, this account only), put
#      export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=<account-id>
#    in a chmod 600 file and start the cron line with `. /path/to/that/file && `.
#    By hand: `node public/publish-static.js --force` after publishing a post or before shutting the machine down;
#    `--dry-run` shows what it would do.
#    Undo: delete the line. The site keeps its last deploy.
```

**Full rollback** (back to the home server serving everything), at any step: g's undo (needs `public` running: h's
undo first if you got that far), then optionally `pm2 stop live`, remove the cron line, and delete the Worker
(`npx wrangler delete lab-kylebaker` in `public/`). The dashboard's file writing is harmless either way.

## 7. Smaller open points

1. **Publishing on events instead of a timer** (a battery finishing, a post saved in the editor). Start with the
   timer; later, call `publish-static.js` from the queue runner's battery-finished path and from
   `lib/postsrepo.save()`.
2. **The status note when live.** The offline note was asked for; I also show a quiet `live — connected to the lab`
   so the two states are distinguishable. To hide it: `.site-status[data-state="live"] { display: none }` in `static.css`.
3. **`/blog` redirects to `/writing`** (301). On the home server it serves the writing shell but the client shows the
   overview. I kept the redirect.
4. **Cloudflare Web Analytics.** If you switch it on for the site it injects a script from
   `static.cloudflareinsights.com`, which the CSP (`script-src 'self'` plus Google's tag) will block until that host
   is added in `staticsite.js` `csp()`.
5. **Wrangler's Node.** If nvm's Node 22 is ever removed, `publish-static.js` stops with a message naming
   `WRANGLER_NODE`; the site itself is unaffected. If the dashboard's Node changes, `PUBLIC_NODE` names the one whose
   better-sqlite3 opens.
6. **Wrangler 4.151.3 is out** (4.147.0 installed). Nothing here needs it.
