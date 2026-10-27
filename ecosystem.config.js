module.exports = {
  apps: [{
    name: 'dashboard',
    script: 'server4.js',
    cwd: __dirname,
    restart_delay: 2000,   // wait 2s between restart attempts
    max_restarts: 20,      // give up after 20 restarts within min_uptime windows (crash-loop guard)
    min_uptime: 5000,      // must stay up 5s to count as a stable start
    autorestart: true
  }, {
    // The public, read-only site (lab.kylebaker.io; ai.kylebaker.io until 2026-10-22): a separate process with no
    // route into the dashboard.
    // See public/server.js. Restarting it never touches llama-server or the dashboard.
    name: 'public',
    script: 'public/server.js',
    cwd: __dirname,
    env: { PUBLIC_PORT: 3100 },
    restart_delay: 2000,
    max_restarts: 20,
    min_uptime: 5000,
    autorestart: true
  }, {
    // The lab's live API for the static site on Cloudflare (live.kylebaker.io -> 127.0.0.1:3101 through the kb-ai
    // tunnel, path ^/api/; 2026-10-22). A stdlib Python file server (~18 MB): GET/HEAD of the three JSON files the
    // dashboard writes into logs/public-api/, CORS for the site's origins only. It replaces `public` for live data.
    // NOT started by anything yet: `pm2 start ecosystem.config.js --only live` is a step of STATIC-ARCHITECTURE.md 6.
    name: 'live',
    script: 'public/live_server.py',
    interpreter: 'python3',
    cwd: __dirname,
    env: { LIVE_PORT: 3101 },   // LIVE_CORS_ORIGINS (comma separated) narrows the origins; the default is in the file
    restart_delay: 2000,
    max_restarts: 20,
    min_uptime: 5000,
    autorestart: true
  }]
};
