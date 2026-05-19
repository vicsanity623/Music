#!/usr/bin/env bash
# ============================================================
#  🎵  SoundVault Downloader
#  Intel iMac compatible — macOS 12+
#  Dependencies: yt-dlp, ffmpeg, python3
# ============================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Config ───────────────────────────────────────────────────
MUSIC_ROOT="/Volumes/XTRA/PYOB2026MAY/MusicLibrary"
ALBUMS_DIR="$MUSIC_ROOT/Albums"
STEMS_DIR="$MUSIC_ROOT/STEMS"
AUDIO_FORMAT="${AUDIO_FORMAT:-mp3}"          # mp3 | flac
AUDIO_QUALITY="${AUDIO_QUALITY:-320}"        # kbps for mp3
COOKIE_FILE=""                               # optional: path to cookies.txt

# Detect local Python interpreter (prefer active virtualenv or local .venv2)
PYTHON_BIN="python3"
if [[ -x "$(dirname "$0")/.venv2/bin/python3" ]]; then
  PYTHON_BIN="$(dirname "$0")/.venv2/bin/python3"
fi

log()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()     { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()    { echo -e "${RED}[ERR]${NC}   $*" >&2; }
header() { echo -e "\n${BOLD}${BLUE}══════════════════════════════════════════${NC}"; echo -e "${BOLD}${BLUE}  $*${NC}"; echo -e "${BOLD}${BLUE}══════════════════════════════════════════${NC}\n"; }

# ── Dependency check ─────────────────────────────────────────
check_deps() {
  header "Checking dependencies"
  local missing=()

  for cmd in yt-dlp ffmpeg python3; do
    if command -v "$cmd" &>/dev/null; then
      ok "$cmd found: $(command -v "$cmd")"
    else
      err "$cmd NOT FOUND"
      missing+=("$cmd")
    fi
  done

  # Log which Python interpreter we are using
  log "Using Python interpreter: $($PYTHON_BIN -c 'import sys; print(sys.executable)')"

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo ""
    err "Missing dependencies. Install them with:"
    echo ""
    echo "  # Homebrew (recommended for Intel iMac)"
    echo "  brew install yt-dlp ffmpeg python3"
    echo ""
    exit 1
  fi
  ok "All dependencies satisfied"
}

# ── Sanitise filename ─────────────────────────────────────────
sanitise() {
  echo "$1" | sed 's/[\/\\:*?"<>|]/_/g' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | cut -c1-120
}

# ── Download a single track ───────────────────────────────────
download_track() {
  local url="$1"
  local out_dir="$2"
  local track_num="$3"

  log "Downloading track $track_num → $out_dir"

  local yt_opts=(
    --no-playlist
    --extract-audio
    --audio-quality "$AUDIO_QUALITY"
    --embed-metadata
    --add-metadata
    --parse-metadata "%(uploader)s:%(artist)s"
    --output "$out_dir/%(autonumber)s - %(title)s.%(ext)s"
    --autonumber-start "$track_num"
    --restrict-filenames
    --no-mtime
  )

  if [[ "$AUDIO_FORMAT" == "flac" ]]; then
    yt_opts+=(--audio-format flac)
  else
    yt_opts+=(--audio-format mp3)
  fi

  [[ -n "$COOKIE_FILE" ]] && yt_opts+=(--cookies "$COOKIE_FILE")

  yt-dlp "${yt_opts[@]}" "$url"
}

# ── Process a full YouTube playlist / album URL ───────────────
process_album() {
  local playlist_url="$1"
  local album_name="$2"

  album_name=$(sanitise "$album_name")
  local album_dir="$ALBUMS_DIR/$album_name"

  mkdir -p "$album_dir"

  header "Album: $album_name"
  log "Fetching track list…"

  # Get list of video URLs in playlist order
  local url_list
  url_list=$(yt-dlp --flat-playlist --get-url "$playlist_url" 2>/dev/null)

  if [[ -z "$url_list" ]]; then
    err "Could not retrieve any URLs from: $playlist_url"
    return 1
  fi

  local total
  total=$(echo "$url_list" | wc -l | tr -d ' ')
  log "Found $total track(s) in playlist"

  local track_num=1
  while IFS= read -u 3 -r track_url; do
    [[ -z "$track_url" ]] && continue

    echo ""
    echo -e "${BOLD}▶  Track $track_num / $total${NC}"

    local raw_title
    raw_title=$(yt-dlp --get-title --no-playlist "$track_url" 2>/dev/null || echo "Track_${track_num}")

    # Build padded track number for filename sorting
    local padded
    padded=$(printf "%02d" "$track_num")

    local yt_opts=(
      --no-playlist
      --extract-audio
      --audio-quality "$AUDIO_QUALITY"
      --embed-metadata
      --add-metadata
      --parse-metadata "%(uploader)s:%(artist)s"
      --output "$album_dir/${padded} - %(title)s.%(ext)s"
      --restrict-filenames
      --no-mtime
      --no-overwrites
    )

    if [[ "$AUDIO_FORMAT" == "flac" ]]; then
      yt_opts+=(--audio-format flac)
    else
      yt_opts+=(--audio-format mp3)
    fi
    [[ -n "$COOKIE_FILE" ]] && yt_opts+=(--cookies "$COOKIE_FILE")

    if ! yt-dlp "${yt_opts[@]}" "$track_url"; then
      warn "Download failed for track $track_num ($raw_title), skipping to next"
      ((track_num++))
      continue
    fi

    # Locate the freshly downloaded file
    local downloaded_file
    downloaded_file=$(find "$album_dir" -maxdepth 1 -name "${padded} -*" \( -name "*.mp3" -o -name "*.flac" \) | sort | tail -1)

    if [[ -z "$downloaded_file" ]]; then
      warn "Could not locate downloaded file for track $track_num"
      ((track_num++))
      continue
    fi
    ok "Downloaded → $downloaded_file"

    ok "Track $track_num complete ✓"
    ((track_num++))
  done 3<<< "$url_list"

  header "Album complete: $album_name"
  echo -e "  Audio  → ${CYAN}$album_dir${NC}"
  
  # Run art_fetch.py to fetch official art and rename tracks!
  log "Running SoundVault Art Fetcher & Organiser..."
  $PYTHON_BIN "$(dirname "$0")/art_fetch.py" --album "$album_name"
}

# ── Download a single video (non-playlist) ────────────────────
process_single() {
  local url="$1"
  local album_name="$2"

  album_name=$(sanitise "$album_name")
  local album_dir="$ALBUMS_DIR/$album_name"
  mkdir -p "$album_dir"

  header "Single track → album: $album_name"

  local yt_opts=(
    --no-playlist
    --extract-audio
    --audio-quality "$AUDIO_QUALITY"
    --embed-metadata
    --add-metadata
    --parse-metadata "%(uploader)s:%(artist)s"
    --output "$album_dir/%(title)s.%(ext)s"
    --restrict-filenames
    --no-mtime
    --no-overwrites
  )
  [[ "$AUDIO_FORMAT" == "flac" ]] && yt_opts+=(--audio-format flac) || yt_opts+=(--audio-format mp3)
  [[ -n "$COOKIE_FILE" ]] && yt_opts+=(--cookies "$COOKIE_FILE")

  yt-dlp "${yt_opts[@]}" "$url"

  header "Single track download complete ✓"
  echo -e "  Audio  → ${CYAN}$album_dir${NC}"
  
  # Run art_fetch.py to fetch official art and rename tracks!
  log "Running SoundVault Art Fetcher & Organiser..."
  $PYTHON_BIN "$(dirname "$0")/art_fetch.py" --album "$album_name"
}

# ── Build library index (JSON) for the web app ───────────────
build_index() {
  header "Building library index"
  $PYTHON_BIN "$(dirname "$0")/art_fetch.py"
}

# ── Interactive menu ──────────────────────────────────────────
interactive_menu() {
  header "🎵  SoundVault Downloader"
  echo "  Music library root: ${CYAN}$MUSIC_ROOT${NC}"
  echo ""
  echo "  [1]  Download YouTube playlist / album"
  echo "  [2]  Download single YouTube video"
  echo "  [3]  Re-build library index only"
  echo "  [4]  Check dependencies"
  echo "  [q]  Quit"
  echo ""
  read -rp "  Choose: " choice

  case "$choice" in
    1)
      read -rp "  Playlist URL : " purl
      read -rp "  Album name   : " aname
      [[ -z "$aname" ]] && { err "Album name required"; exit 1; }
      process_album "$purl" "$aname"
      ;;
    2)
      read -rp "  Video URL    : " vurl
      read -rp "  Album/folder : " aname
      [[ -z "$aname" ]] && { err "Album name required"; exit 1; }
      process_single "$vurl" "$aname"
      ;;
    3)
      build_index
      ;;
    4)
      check_deps
      ;;
    q|Q)
      echo "Bye!"; exit 0
      ;;
    *)
      err "Invalid choice"; exit 1
      ;;
  esac
}

# ── CLI entrypoint ────────────────────────────────────────────
main() {
  mkdir -p "$ALBUMS_DIR" "$STEMS_DIR"

  if [[ $# -eq 0 ]]; then
    check_deps
    interactive_menu
  elif [[ "$1" == "--check" ]]; then
    check_deps
  elif [[ "$1" == "--index" ]]; then
    build_index
  elif [[ "$1" == "--album" ]]; then
    # Usage: ./download_and_stem.sh --album "https://..." "Album Name"
    check_deps
    [[ -z "${2:-}" ]] && { err "Usage: $0 --album <url> <name>"; exit 1; }
    [[ -z "${3:-}" ]] && { err "Usage: $0 --album <url> <name>"; exit 1; }
    process_album "$2" "$3"
  elif [[ "$1" == "--single" ]]; then
    # Usage: ./download_and_stem.sh --single "https://..." "Album Name"
    check_deps
    [[ -z "${2:-}" ]] && { err "Usage: $0 --single <url> <album>"; exit 1; }
    [[ -z "${3:-}" ]] && { err "Usage: $0 --single <url> <album>"; exit 1; }
    process_single "$2" "$3"
  else
    echo "Usage:"
    echo "  $0                          # interactive menu"
    echo "  $0 --check                  # check deps"
    echo "  $0 --album  <url> <name>    # download playlist"
    echo "  $0 --single <url> <name>    # download single video"
    echo "  $0 --index                  # rebuild library.json"
    exit 0
  fi
}

main "$@"
