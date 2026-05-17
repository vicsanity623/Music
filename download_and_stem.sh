#!/usr/bin/env bash
# ============================================================
#  🎵  Music Downloader + Stem Splitter
#  Intel iMac compatible — macOS 12+
#  Dependencies: yt-dlp, ffmpeg, python3, demucs
# ============================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Config ───────────────────────────────────────────────────
MUSIC_ROOT="${MUSIC_ROOT:-$HOME/MusicLibrary}"
ALBUMS_DIR="$MUSIC_ROOT/Albums"
STEMS_DIR="$MUSIC_ROOT/STEMS"
AUDIO_FORMAT="${AUDIO_FORMAT:-mp3}"          # mp3 | flac
AUDIO_QUALITY="${AUDIO_QUALITY:-320}"        # kbps for mp3
DEMUCS_MODEL="htdemucs_ft"                   # high-quality 4-stem model
STEMS_FMT="mp3"                              # format for stem output files
STEMS_QUALITY=320                            # kbps for stems
COOKIE_FILE=""                               # optional: path to cookies.txt

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

  # Check demucs python package
  if python3 -c "import demucs" 2>/dev/null; then
    ok "demucs python package found"
  else
    err "demucs python package NOT FOUND"
    missing+=("demucs")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo ""
    err "Missing dependencies. Install them with:"
    echo ""
    echo "  # Homebrew (recommended for Intel iMac)"
    echo "  brew install yt-dlp ffmpeg"
    echo "  pip3 install demucs"
    echo ""
    echo "  # Or with pipx (isolated environment)"
    echo "  brew install pipx"
    echo "  pipx install demucs"
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
    --embed-thumbnail
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

# ── Run htdemucs_ft on one audio file ────────────────────────
stem_track() {
  local audio_file="$1"   # full path to downloaded track
  local stem_out_dir="$2" # where to write the 4 stems
  local track_name="$3"   # display name

  log "Stemming: $track_name"
  log "  Model : $DEMUCS_MODEL"
  log "  Output: $stem_out_dir"

  mkdir -p "$stem_out_dir"

  # demucs outputs to <out>/<model>/<track>/{vocals,drums,bass,other}.wav
  local tmp_demucs="$stem_out_dir/_demucs_tmp"
  mkdir -p "$tmp_demucs"

  python3 -m demucs \
    --name "$DEMUCS_MODEL" \
    --out "$tmp_demucs" \
    "$audio_file" 2>&1 | while IFS= read -r line; do echo "    $line"; done

  # Find the wav outputs and convert to mp3/flac
  local model_dir="$tmp_demucs/$DEMUCS_MODEL"
  local track_basename
  track_basename=$(basename "$audio_file")
  track_basename="${track_basename%.*}"

  # demucs slugifies the filename; find the matching dir
  local demucs_track_dir
  demucs_track_dir=$(find "$model_dir" -maxdepth 1 -type d | grep -v "^$model_dir$" | head -1)

  if [[ -z "$demucs_track_dir" ]]; then
    err "demucs produced no output for: $audio_file"
    rm -rf "$tmp_demucs"
    return 1
  fi

  for stem in vocals drums bass other; do
    local wav_in="$demucs_track_dir/${stem}.wav"
    if [[ -f "$wav_in" ]]; then
      local out_file="$stem_out_dir/${stem}.${STEMS_FMT}"
      if [[ "$STEMS_FMT" == "flac" ]]; then
        ffmpeg -y -i "$wav_in" -c:a flac "$out_file" -loglevel error
      else
        ffmpeg -y -i "$wav_in" -c:a libmp3lame -b:a "${STEMS_QUALITY}k" "$out_file" -loglevel error
      fi
      ok "  Stem saved → $out_file"
    else
      warn "  Stem not found: $wav_in"
    fi
  done

  rm -rf "$tmp_demucs"
}

# ── Process a full YouTube playlist / album URL ───────────────
process_album() {
  local playlist_url="$1"
  local album_name="$2"

  album_name=$(sanitise "$album_name")
  local album_dir="$ALBUMS_DIR/$album_name"
  local stems_album_dir="$STEMS_DIR/${album_name}STEMS"

  mkdir -p "$album_dir" "$stems_album_dir"

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
  while IFS= read -r track_url; do
    [[ -z "$track_url" ]] && continue

    echo ""
    echo -e "${BOLD}▶  Track $track_num / $total${NC}"

    # ── 1. Get title for display & stem folder naming ──────────
    local raw_title
    raw_title=$(yt-dlp --get-title --no-playlist "$track_url" 2>/dev/null || echo "Track_${track_num}")
    local safe_title
    safe_title=$(sanitise "$raw_title")

    # ── 2. Download ────────────────────────────────────────────
    # Build padded track number for filename sorting
    local padded
    padded=$(printf "%02d" "$track_num")

    local yt_opts=(
      --no-playlist
      --extract-audio
      --audio-quality "$AUDIO_QUALITY"
      --embed-thumbnail
      --embed-metadata
      --add-metadata
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
      warn "Download failed for track $track_num ($raw_title), skipping stem step"
      ((track_num++))
      continue
    fi

    # ── 3. Find the freshly downloaded file ───────────────────
    local downloaded_file
    downloaded_file=$(find "$album_dir" -maxdepth 1 -name "${padded} -*" \( -name "*.mp3" -o -name "*.flac" \) | sort | tail -1)

    if [[ -z "$downloaded_file" ]]; then
      warn "Could not locate downloaded file for track $track_num, skipping stems"
      ((track_num++))
      continue
    fi
    ok "Downloaded → $downloaded_file"

    # ── 4. Stem split ─────────────────────────────────────────
    local track_stem_dir="$stems_album_dir/$safe_title"
    stem_track "$downloaded_file" "$track_stem_dir" "$raw_title"

    ok "Track $track_num complete ✓"
    ((track_num++))
  done <<< "$url_list"

  header "Album complete: $album_name"
  echo -e "  Audio  → ${CYAN}$album_dir${NC}"
  echo -e "  Stems  → ${CYAN}$stems_album_dir${NC}"
}

# ── Download a single video (non-playlist) ────────────────────
process_single() {
  local url="$1"
  local album_name="$2"

  album_name=$(sanitise "$album_name")
  local album_dir="$ALBUMS_DIR/$album_name"
  local stems_album_dir="$STEMS_DIR/${album_name}STEMS"
  mkdir -p "$album_dir" "$stems_album_dir"

  header "Single track → album: $album_name"

  local yt_opts=(
    --no-playlist
    --extract-audio
    --audio-quality "$AUDIO_QUALITY"
    --embed-thumbnail
    --embed-metadata
    --add-metadata
    --output "$album_dir/%(title)s.%(ext)s"
    --restrict-filenames
    --no-mtime
    --no-overwrites
  )
  [[ "$AUDIO_FORMAT" == "flac" ]] && yt_opts+=(--audio-format flac) || yt_opts+=(--audio-format mp3)
  [[ -n "$COOKIE_FILE" ]] && yt_opts+=(--cookies "$COOKIE_FILE")

  yt-dlp "${yt_opts[@]}" "$url"

  local downloaded_file
  downloaded_file=$(find "$album_dir" -maxdepth 1 \( -name "*.mp3" -o -name "*.flac" \) | sort | tail -1)

  if [[ -n "$downloaded_file" ]]; then
    local raw_title
    raw_title=$(basename "$downloaded_file")
    raw_title="${raw_title%.*}"
    local track_stem_dir="$stems_album_dir/$raw_title"
    stem_track "$downloaded_file" "$track_stem_dir" "$raw_title"
  fi
}

# ── Build library index (JSON) for the web app ───────────────
build_index() {
  header "Building library index"
  local index_file="$MUSIC_ROOT/library.json"

  python3 - "$ALBUMS_DIR" "$STEMS_DIR" "$index_file" <<'PYEOF'
import json, os, sys, re
from pathlib import Path

albums_root = Path(sys.argv[1])
stems_root  = Path(sys.argv[2])
out_path    = Path(sys.argv[3])

library = {"albums": []}
audio_exts = {".mp3", ".flac", ".m4a", ".ogg", ".wav"}

for album_dir in sorted(albums_root.iterdir()):
    if not album_dir.is_dir():
        continue
    tracks = []
    for f in sorted(album_dir.iterdir()):
        if f.suffix.lower() not in audio_exts:
            continue
        stem_folder_name = re.sub(r'^\d+\s*-\s*', '', f.stem)  # strip leading "01 - "
        stem_dir = stems_root / (album_dir.name + "STEMS") / stem_folder_name
        stems = {}
        for stem in ("vocals", "drums", "bass", "other"):
            for ext in (".mp3", ".flac", ".wav"):
                sp = stem_dir / (stem + ext)
                if sp.exists():
                    stems[stem] = str(sp.relative_to(out_path.parent))
                    break
        tracks.append({
            "title": stem_folder_name,
            "filename": f.name,
            "path": str(f.relative_to(out_path.parent)),
            "format": f.suffix.lstrip(".").upper(),
            "stems": stems
        })
    if tracks:
        library["albums"].append({
            "name": album_dir.name,
            "path": str(album_dir.relative_to(out_path.parent)),
            "tracks": tracks
        })

out_path.write_text(json.dumps(library, indent=2, ensure_ascii=False))
print(f"Index written → {out_path}  ({len(library['albums'])} albums)")
PYEOF
  ok "Index written → $index_file"
}

# ── Interactive menu ──────────────────────────────────────────
interactive_menu() {
  header "🎵  Music Downloader + Stem Splitter"
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
      build_index
      ;;
    2)
      read -rp "  Video URL    : " vurl
      read -rp "  Album/folder : " aname
      [[ -z "$aname" ]] && { err "Album name required"; exit 1; }
      process_single "$vurl" "$aname"
      build_index
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
    build_index
  elif [[ "$1" == "--single" ]]; then
    # Usage: ./download_and_stem.sh --single "https://..." "Album Name"
    check_deps
    [[ -z "${2:-}" ]] && { err "Usage: $0 --single <url> <album>"; exit 1; }
    [[ -z "${3:-}" ]] && { err "Usage: $0 --single <url> <album>"; exit 1; }
    process_single "$2" "$3"
    build_index
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
