#!/usr/bin/env python3
# The lab's live API for the static public site, at live.kylebaker.io (2026-10-22). See STATIC-ARCHITECTURE.md.
# Kyle: "tiny python server sounds fine" -- it replaces the ~0.7 GiB node `public` process for this.
# It serves the JSON files the dashboard writes every 3 s into logs/public-api/ (lib/publiclive.js) and nothing else:
# GET/HEAD on three fixed paths, 127.0.0.1 only (the tunnel is the way in), no write path, no logic. A file older than
# LIVE_STALE_S is a 503 -- the dashboard has stopped writing -- which the page (static-mode.js) reads as "offline".
# Env: LIVE_PORT (3101), LIVE_DIR (experiment-1/logs/public-api), LIVE_STALE_S (30), LIVE_CORS_ORIGINS (comma separated).
import http.server, os, time

DIR = os.environ.get('LIVE_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'logs', 'public-api')
ROUTES = {'/api/stats': 'stats.json', '/api/live': 'live.json', '/api/models/running': 'running.json'}
ORIGINS = set((os.environ.get('LIVE_CORS_ORIGINS') or 'https://lab.kylebaker.io').split(','))
STALE_S = float(os.environ.get('LIVE_STALE_S') or 30)


class Handler(http.server.BaseHTTPRequestHandler):
    def version_string(self):   # the Server header: no Python version
        return 'live'

    def do_GET(self, head=False):
        name, code, body = ROUTES.get(self.path.split('?', 1)[0]), 404, b'{"error":"not found"}'
        if name:
            try:
                f = os.path.join(DIR, name)
                code, body = (503, b'{"error":"stale"}') if time.time() - os.stat(f).st_mtime > STALE_S else (200, open(f, 'rb').read())
            except OSError:
                code, body = 503, b'{"error":"unavailable"}'
        self.send_response(code)
        for k, v in (('Content-Type', 'application/json'), ('Content-Length', str(len(body))), ('Cache-Control', 'no-store'),
                     ('X-Content-Type-Options', 'nosniff'), ('Vary', 'Origin')):
            self.send_header(k, v)
        if self.headers.get('Origin') in ORIGINS:   # echo a listed origin only; never credentials
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET(head=True)

    def log_message(self, *args):   # quiet: one line per poll would only fill pm2's log
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('LIVE_PORT') or 3101)), Handler).serve_forever()
