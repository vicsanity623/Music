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

  cd "$WEB_ROOT"

  # Python 3 — allows CORS and proper MIME types
  python3 - "$PORT" <<'PYEOF'
import sys, os, http.server, socketserver
from http.server import SimpleHTTPRequestHandler

PORT = int(sys.argv[1])

class MusicHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

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
