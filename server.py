import sys, os, re, shutil, json, hmac, hashlib, base64, time, http.server, socketserver, functools
from http.server import SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs


def _reject_radio_playlist(url):
    """Auto-generated radio/mix URLs (list=RD…/RA… or start_radio=1) expand to
    500–1000+ tracks. Refuse them so a stray paste can never cause a mass download."""
    try:
        q = parse_qs(urlparse(url or '').query)
        if q.get('start_radio', [''])[0] == '1':
            return True
        if q.get('list', [''])[0].upper().startswith(('RD', 'RA')):
            return True
    except Exception:
        pass
    return False

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
WEB_ROOT = os.environ.get('WEB_ROOT', '/Volumes/XTRA/PYOB2026MAY/MusicLibrary/web')

# ── Auth (locked to the two approved users) ───────────────────────────────────
# Users live in auth.json OUTSIDE the web root and OUTSIDE the git repo, so the
# file is never published to GitHub Pages and never served over HTTP.
AUTH_FILE = os.environ.get('AUTH_FILE', '/Volumes/XTRA/PYOB2026MAY/MusicLibrary/auth.json')

def _load_auth():
    try:
        with open(AUTH_FILE) as f:
            data = json.load(f)
        users = data.get('users') or {}
        secret = data.get('token_secret') or ''
        if not users or not secret:
            raise ValueError('auth.json must contain "users" and "token_secret"')
        return users, secret
    except Exception as e:
        print(f'[auth] FATAL: cannot load {AUTH_FILE}: {e}', file=sys.stderr)
        sys.exit(1)

AUTH_USERS, AUTH_SECRET = _load_auth()
AUTH_SECRET = AUTH_SECRET.encode('utf-8')

# Simple in-memory failed-login rate limit: {ip: [timestamps]}
_LOGIN_FAILURES = {}
_LOGIN_MAX_FAILURES = 5
_LOGIN_WINDOW_SECS = 15 * 60
_LOGIN_PENALTY_SECS = 1.0

def _login_rate_limited(ip):
    now = time.time()
    stamps = [t for t in _LOGIN_FAILURES.get(ip, []) if now - t < _LOGIN_WINDOW_SECS]
    _LOGIN_FAILURES[ip] = stamps
    return len(stamps) >= _LOGIN_MAX_FAILURES

def _record_login_failure(ip):
    _LOGIN_FAILURES.setdefault(ip, []).append(time.time())

def _verify_password(entry, password):
    """Constant-time check of a PBKDF2-SHA256 salted hash."""
    try:
        salt = bytes.fromhex(entry['salt'])
        want = entry['hash']
        got = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 200000)
        return hmac.compare_digest(got.hex(), want)
    except Exception:
        return False

def _make_token(username):
    """Signed, tamper-proof session token valid for 10 years (effectively forever)."""
    exp = int(time.time()) + 10 * 365 * 24 * 3600
    payload = f'{username}.{exp}'.encode('utf-8')
    sig = hmac.new(AUTH_SECRET, payload, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(payload).decode('ascii').rstrip('=') + '.' + sig

def _token_user(token):
    """Return the username for a valid token, else None."""
    try:
        body_b64, sig = token.split('.', 1)
        body_b64 += '=' * (-len(body_b64) % 4)
        payload = base64.urlsafe_b64decode(body_b64).decode('utf-8')
        expect = hmac.new(AUTH_SECRET, payload.encode('utf-8'), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expect, sig):
            return None
        username, exp = payload.rsplit('.', 1)
        if int(exp) < time.time():
            return None
        return username if username in AUTH_USERS else None
    except Exception:
        return None

def _request_token(handler):
    """Token from ?token= (audio/img URLs) or Authorization: Bearer (fetch)."""
    auth = handler.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        return auth[7:].strip()
    q = parse_qs(urlparse(handler.path).query)
    return (q.get('token') or [''])[0]


class MusicHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    # ── Auth helpers ──────────────────────────────────────────
    def _send_json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed_user(self):
        """Return the username for a valid request token, else None."""
        return _token_user(_request_token(self))

    def _require_auth(self):
        """True and response untouched if authorized; else sends 401 and False."""
        if self._authed_user():
            return True
        self._send_json(401, {'error': 'Not authenticated'})
        return False

    # App shell (login page + code) must stay reachable so the login form can
    # render. Everything else — library.json, Albums/, STEMS/, api — is locked.
    _PUBLIC_SHELL = {'/', '/index.html', '/main.js', '/style.css', '/sw.js', '/manifest.json'}

    @classmethod
    def _is_public_shell(cls, path):
        return path in cls._PUBLIC_SHELL or path.startswith('/icons/')

    # ── Login / session endpoints (the only public routes) ────
    def _handle_login(self):
        ip = self.client_address[0] if self.client_address else 'unknown'
        if _login_rate_limited(ip):
            self._send_json(429, {'error': 'Too many failed attempts. Try again later.'})
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            self._send_json(400, {'error': 'Bad request'})
            return
        username = str(data.get('username', '')).strip()
        password = str(data.get('password', ''))
        entry = AUTH_USERS.get(username)
        if entry and _verify_password(entry, password):
            _LOGIN_FAILURES.pop(ip, None)
            print(f'[auth] login ok: {username}')
            self._send_json(200, {'status': 'ok', 'user': username, 'token': _make_token(username)})
        else:
            _record_login_failure(ip)
            print(f'[auth] login FAILED: {username!r} from {ip}')
            time.sleep(_LOGIN_PENALTY_SECS)
            self._send_json(401, {'error': 'Wrong username or password'})

    def _handle_check(self):
        user = self._authed_user()
        if user:
            self._send_json(200, {'status': 'ok', 'user': user})
        else:
            self._send_json(401, {'error': 'Not authenticated'})

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def copyfile(self, source, outputfile):
        try:
            shutil.copyfileobj(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/check':
            self._handle_check()
            return
        if not self._is_public_shell(path) and not self._require_auth():
            return
        super().do_GET()

    def do_HEAD(self):
        path = urlparse(self.path).path
        if not self._is_public_shell(path) and not self._require_auth():
            return
        super().do_HEAD()

    def do_POST(self):
        import json
        import subprocess
        import datetime

        path = urlparse(self.path).path

        if path == '/api/login':
            self._handle_login()
            return

        if not self._require_auth():
            return

        if path in ('/download-playlist', '/api/download-playlist'):
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                playlist_url = data.get('url')
                if playlist_url:
                    if _reject_radio_playlist(playlist_url):
                        self.send_response(400)
                        self.send_header('Content-Type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({'error': 'Auto-generated radio playlists are not supported (they contain hundreds of tracks). Use a single video URL instead.'}).encode('utf-8'))
                        return
                    script_dir = os.environ.get('SCRIPT_DIR', '')
                    script_path = os.path.join(script_dir, 'download_and_stem.sh')
                    log_path = os.path.join(script_dir, 'playlist_import_log.txt')
                    with open(log_path, 'a') as f_log:
                        f_log.write(f"\n--- Import started at {datetime.datetime.now()} for {playlist_url} ---\n")
                        subprocess.Popen(
                            [script_path, '--album', playlist_url, '_Unsorted'],
                            cwd=script_dir,
                            stdin=subprocess.DEVNULL,
                            stdout=f_log,
                            stderr=subprocess.STDOUT
                        )
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                else:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'error': 'Missing url'}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
            return

        if path in ('/download-single', '/api/download-single'):
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                video_url = data.get('url')
                if video_url:
                    script_dir = os.environ.get('SCRIPT_DIR', '')
                    script_path = os.path.join(script_dir, 'download_and_stem.sh')
                    log_path = os.path.join(script_dir, 'playlist_import_log.txt')
                    with open(log_path, 'a') as f_log:
                        f_log.write(f"\n--- Single import started at {datetime.datetime.now()} for {video_url} ---\n")
                        subprocess.Popen(
                            [script_path, '--single', video_url, '_Unsorted'],
                            cwd=script_dir,
                            stdin=subprocess.DEVNULL,
                            stdout=f_log,
                            stderr=subprocess.STDOUT
                        )
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                else:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'error': 'Missing url'}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
            return

        self.send_response(404)
        self.end_headers()

    def guess_type(self, path):
        t = super().guess_type(path)
        ext = os.path.splitext(path)[1].lower()
        mime_map = {
            '.mp3':  'audio/mpeg',
            '.flac': 'audio/flac',
            '.m4a':  'audio/mp4',
            '.ogg':  'audio/ogg',
            '.wav':  'audio/wav',
            '.json': 'application/json',
            '.webmanifest': 'application/manifest+json',
        }
        return mime_map.get(ext, t or 'application/octet-stream')

    def log_message(self, fmt, *args):
        if args:
            # Never write session tokens to the log file.
            args = tuple(
                re.sub(r'token=[^&\s]+', 'token=REDACTED', a) if isinstance(a, str) else a
                for a in args
            )
        if args and str(args[1]) not in ('200', '206', '304'):
            super().log_message(fmt, *args)

handler = functools.partial(MusicHandler, directory=WEB_ROOT)
with socketserver.TCPServer(("", PORT), handler) as httpd:
    httpd.allow_reuse_address = True
    print(f"[server] Listening on http://0.0.0.0:{PORT}")
    httpd.serve_forever()
