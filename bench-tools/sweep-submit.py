#!/usr/bin/env python3
"""Queue a headless Launch Sweep and (optionally) watch it to completion.

The sweep runs inside the dashboard server, so this script can exit at any
time -- ^C only stops the watching, not the run. Use --stop to actually stop.

  sweep-submit.py --lines ~/sweep-lines.txt --prompt ~/sweep-prompt.txt --watch
  sweep-submit.py --status
  sweep-submit.py --stop
"""
import argparse, json, os, sys, time, urllib.request, urllib.error

AUTH = None  # Bearer token for the tunnel gate; set from --password-file


def call(host, path, body=None, timeout=30):
    url = f'http://{host}{path}'
    data = json.dumps(body).encode() if body is not None else None
    headers = {}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    # Loopback needs no auth until a tunnel is up; once it is -- and always for
    # a cross-machine call -- the gate 401s anything without a session cookie
    # or a Bearer password. Read from the file, sent as a header, never printed.
    if AUTH:
        headers['Authorization'] = f'Bearer {AUTH}'
    req = urllib.request.Request(url, data=data, method='POST' if data is not None else 'GET',
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b'{}')
        except Exception: return e.code, {'error': e.reason}

def fmt(v, n=1, suffix=''):
    return f'{v:.{n}f}{suffix}' if isinstance(v, (int, float)) else '--'

def show(st):
    if st.get('idle'):
        print('idle -- no sweep has run yet'); return
    head = 'running' if st.get('running') else 'finished'
    if st.get('cancelled'): head += ' (cancelled)'
    cur = f"  current: {st['current']}" if st.get('current') else ''
    print(f"{head}: reps={st.get('reps')} genTokens={st.get('genTokens')}{cur}")
    if st.get('error'): print(f"  ERROR: {st['error']}")
    print(f"\n  {'label':22s} {'st':>5s} {'n':>2s} {'gen t/s':>9s} {'+/-':>6s} "
          f"{'pp t/s':>8s} {'draft':>6s} {'wall':>7s}")
    for r in st.get('summary', []):
        spread = r.get('genTpsSpread')
        acc = r.get('draftAcceptRate')
        print(f"  {r['label']:22s} {r['status'][:5]:>5s} {r['n']:>2d} "
              f"{fmt(r.get('genTps')):>9s} {('+/-'+fmt(spread/2)) if isinstance(spread,(int,float)) else '--':>6s} "
              f"{fmt(r.get('promptTps')):>8s} "
              f"{fmt(acc*100, 0, '%') if isinstance(acc,(int,float)) else '--':>6s} "
              f"{fmt(r.get('wallTime')):>7s}")
        if r.get('error'): print(f"      ! {r['error']}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1:3000')
    ap.add_argument('--password-file', default='~/.config/ai-dashboard/tunnel-password',
                    help='tunnel password, needed when the gate is up or the host is remote')
    ap.add_argument('--lines'); ap.add_argument('--prompt')
    ap.add_argument('--build', help="llama-server build id to sweep with (see /api/builds). "
                    "Without it the server picks the first build mentioning 'cuda', which is wrong for a "
                    "model whose architecture only exists in one tree -- e.g. Flash-Next/qwen4exp needs u144-hip.")
    ap.add_argument('--reps', type=int, default=5)
    ap.add_argument('--gen-tokens', type=int, default=1024)
    ap.add_argument('--cooldown-c', type=int, default=0,
                    help='hold until every GPU is at/below this temp before each config')
    ap.add_argument('--watch', action='store_true')
    ap.add_argument('--status', action='store_true'); ap.add_argument('--stop', action='store_true')
    a = ap.parse_args()

    global AUTH
    pf = os.path.expanduser(a.password_file or '')
    if pf and os.path.exists(pf):
        AUTH = open(pf).read().strip() or None

    if a.status or a.stop:
        code, out = call(a.host, '/api/sweep/stop' if a.stop else '/api/sweep/status',
                         {} if a.stop else None)
        if code == 401:
            print('tunnel gate active -- pass --password-file', file=sys.stderr); return 1
        if code == 404:
            print('no /api/sweep on this dashboard -- it predates the headless sweep; '
                  'restart it to pick up the new server4.js', file=sys.stderr); return 1
        if code != 200:
            print(f"error ({code}): {out.get('error')}", file=sys.stderr); return 1
        if a.stop: print(json.dumps(out))
        else: show(out)
        return 0
    if not a.lines or not a.prompt:
        ap.error('--lines and --prompt are required to start a sweep')

    lines = [l.strip() for l in open(a.lines) if l.strip()]
    prompt = open(a.prompt).read()
    code, out = call(a.host, '/api/sweep/start', {
        'lines': lines, 'prompt': prompt, 'reps': a.reps,
        'genTokens': a.gen_tokens, 'cooldownC': a.cooldown_c,
        **({'build': a.build} if a.build else {})})
    if code == 401:
        print('refused: tunnel gate active -- pass --password-file (default '
              '~/.config/ai-dashboard/tunnel-password)', file=sys.stderr); return 1
    if code != 200:
        print(f"refused ({code}): {out.get('error')}", file=sys.stderr); return 1
    est = len(lines) * a.reps
    print(f"queued {len(out['rows'])} configs x {a.reps} reps = {est} runs")
    print(f"prompt: {len(prompt)} chars   build: {out['build']}")
    for r in out['rows']: print(f"  - {r}")
    if not a.watch:
        print(f"\nwatch with: {sys.argv[0]} --status"); return 0
    try:
        while True:
            time.sleep(20)
            st = call(a.host, '/api/sweep/status')[1]
            print('\033[2J\033[H', end='')   # repaint in place
            show(st)
            if not st.get('running'): return 0
    except KeyboardInterrupt:
        print('\n(stopped watching -- the sweep is still running server-side)')
        return 0

if __name__ == '__main__':
    sys.exit(main())
