#!/usr/bin/env bash
# ============================================================
#  🌐  Music Library Server
#  Serves the MusicLibrary folder via HTTP on localhost
#  + optionally exposes via Tailscale Funnel (HTTPS)
# ============================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Paths (SSD is the canonical music store) ─────────────────
MUSIC_ROOT="/Volumes/XTRA/PYOB2026MAY/MusicLibrary"
WEB_ROOT="/Volumes/XTRA/PYOB2026MAY/MusicLibrary/web"
PORT="${PORT:-8080}"

log()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()  { echo -e "${RED}[ERR]${NC}   $*" >&2; }

# ── Prepare web root: symlink app files + media dirs ─────────
prepare_web_root() {
  local script_dir
  script_dir="$(cd "$(dirname "$0")" && pwd)"

  mkdir -p "$WEB_ROOT"

  # Always refresh app file symlinks so stale links self-heal
  for f in index.html main.js style.css manifest.json sw.js; do
    [[ -e "$script_dir/$f" ]] && ln -sf "$script_dir/$f" "$WEB_ROOT/$f"
  done

  # Symlink media dirs (force-refresh to catch path changes)
  ln -sf "$MUSIC_ROOT/Albums"       "$WEB_ROOT/Albums"
  ln -sf "$MUSIC_ROOT/STEMS"        "$WEB_ROOT/STEMS"
  ln -sf "$MUSIC_ROOT/library.json" "$WEB_ROOT/library.json" 2>/dev/null || true

  log "Music root : $MUSIC_ROOT"
  log "Web root   : $WEB_ROOT"
  ok  "Web root ready"
}

# ── Start Python HTTP server ──────────────────────────────────
start_server() {
  log "Starting HTTP server on port $PORT …"
  log "Serving: $WEB_ROOT"
  echo ""
  ok "Local access  → http://localhost:$PORT"
  echo ""

  # Capture SCRIPT_DIR before cd
  export SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

  cd "$WEB_ROOT"

  # Python 3 — allows CORS and proper MIME types
  python3 - "$PORT" <<'PYEOF'
import sys, os, http.server, socketserver
from http.server import SimpleHTTPRequestHandler

PORT = int(sys.argv[1])

class MusicHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/download-playlist':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            import json
            import subprocess
            import datetime
            try:
                data = json.loads(post_data.decode('utf-8'))
                playlist_url = data.get('url')
                if playlist_url:
                    script_dir = os.environ.get('SCRIPT_DIR', '')
                    script_path = os.path.join(script_dir, 'download_and_stem.sh')
                    log_path = os.path.join(script_dir, 'playlist_import_log.txt')
                    with open(log_path, 'a') as f_log:
                        f_log.write(f"\n--- Import started at {datetime.datetime.now()} for {playlist_url} ---\n")
                        subprocess.Popen(
                            [script_path, '--album', playlist_url, '_Unsorted'],
                            cwd=script_dir,
                            stdout=f_log,
                            stderr=subprocess.STDOUT
                        )
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                    return
                else:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'error': 'Missing url'}).encode('utf-8'))
                    return
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
        # Only log errors to reduce noise
        if args and str(args[1]) not in ('200', '206', '304'):
            super().log_message(fmt, *args)

with socketserver.TCPServer(("", PORT), MusicHandler) as httpd:
    httpd.allow_reuse_address = True
    print(f"[server] Listening on http://0.0.0.0:{PORT}")
    httpd.serve_forever()
PYEOF
}

# ── Tailscale Funnel ──────────────────────────────────────────
start_tailscale_funnel() {
  log "Setting up Tailscale Funnel…"

  TS_CMD="tailscale"
  if [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
    TS_CMD="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  elif ! command -v tailscale &>/dev/null; then
    err "tailscale CLI not found. Install from https://tailscale.com/download"
    return 1
  fi

  # Start the funnel pointing at the local server port
  # This exposes https://<machine>.tailnet-name.ts.net/ publicly
  $TS_CMD funnel --bg "$PORT"
  echo ""
  ok "Tailscale Funnel active!"
  log "Your public HTTPS URL:"
  $TS_CMD funnel status 2>/dev/null || $TS_CMD status --json 2>/dev/null | python3 -c "
import sys,json; d=json.load(sys.stdin)
dns=d.get('Self',{}).get('DNSName','').rstrip('.')
if dns: print(f'  https://{dns}')
"
}

stop_tailscale_funnel() {
  log "Stopping Tailscale Funnel…"
  TS_CMD="tailscale"
  if [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
    TS_CMD="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  fi
  $TS_CMD funnel off 2>/dev/null || true
  ok "Funnel stopped"
}

# ── Menu ──────────────────────────────────────────────────────
usage() {
  echo ""
  echo -e "${BOLD}Music Library Server${NC}"
  echo ""
  echo "  serve.sh              — start local server only"
  echo "  serve.sh --funnel     — start server + Tailscale Funnel (HTTPS)"
  echo "  serve.sh --funnel-off — stop Tailscale Funnel"
  echo "  serve.sh --status     — show Tailscale Funnel status"
  echo ""
}

main() {
  prepare_web_root

  case "${1:-}" in
    --funnel)
      start_tailscale_funnel &
      start_server
      ;;
    --funnel-off)
      stop_tailscale_funnel
      ;;
    --status)
      tailscale funnel status
      ;;
    --help|-h)
      usage
      ;;
    "")
      start_server
      ;;
    *)
      err "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
}

main "$@"
