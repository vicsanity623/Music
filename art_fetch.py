#!/usr/bin/env python3.11
"""
SoundVault — art_fetch.py
=========================
Fetches official album art from MusicBrainz/Cover Art Archive,
renames tracks to official titles, embeds art into tags,
and rebuilds library.json.

Usage:
  python3 art_fetch.py                     # all albums
  python3 art_fetch.py --dry-run           # preview only
  python3 art_fetch.py --album "2Pac"      # one album
  python3 art_fetch.py --no-index          # skip library.json rebuild

Requirements:
  pip3 install mutagen requests
"""

import argparse, json, os, re, sys, time, shutil
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing: pip3 install requests")

try:
    from mutagen.mp3 import MP3
    from mutagen.id3 import ID3, APIC, TIT2, TPE1
    from mutagen.flac import FLAC, Picture
except ImportError:
    sys.exit("Missing: pip3 install mutagen")

# ── Config ────────────────────────────────────────────────────────────────────
MUSIC_ROOT = Path("/Volumes/XTRA/PYOB2026MAY/MusicLibrary")
ALBUMS_DIR = MUSIC_ROOT / "Albums"
STEMS_DIR  = MUSIC_ROOT / "STEMS"
INDEX_FILE = MUSIC_ROOT / "library.json"
AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".wav"}

MB_BASE    = "https://musicbrainz.org/ws/2"
CAA_BASE   = "https://coverartarchive.org/release"
UA         = "SoundVault/1.0 (https://github.com/vicsanity623/Music)"
RATE_LIMIT = 1.2   # seconds between MB requests (be polite)

# ── YouTube junk stripper ─────────────────────────────────────────────────────
YT_JUNK = re.compile(
    r"[\(\[\{]?\s*(?:official\s*(?:music\s*)?(?:video|audio|clip|hd|4k|lyric[s]?|visualizer)?|"
    r"music\s*video|lyric[s]?\s*video|official|explicit|dirty|clean\s*version|"
    r"radio\s*edit|full\s*(?:song|version)|hd|hq|4k|1080p|720p)\s*[\)\]\}]?",
    re.IGNORECASE,
)
TRACK_NUM_RE = re.compile(r"^\d+\s*[-_.]\s*")

# ── Rate-limited MusicBrainz GET ──────────────────────────────────────────────
_last_mb = 0.0

def mb_get(endpoint, params):
    global _last_mb
    wait = RATE_LIMIT - (time.time() - _last_mb)
    if wait > 0:
        time.sleep(wait)
    params["fmt"] = "json"
    try:
        r = requests.get(f"{MB_BASE}/{endpoint}", params=params,
                         headers={"User-Agent": UA}, timeout=15)
        _last_mb = time.time()
        if r.status_code == 200:
            return r.json()
        if r.status_code == 503:
            print("  ⚠ Rate-limited by MB, sleeping 10s…"); time.sleep(10)
    except Exception as e:
        print(f"  ✗ MB error: {e}")
    return None

# ── Helpers ───────────────────────────────────────────────────────────────────
def clean_title(raw):
    t = raw.replace("_", " ")
    t = TRACK_NUM_RE.sub("", t)
    if " - " in t:
        # "Artist - Title" → keep after the dash
        t = t.split(" - ", 1)[1]
    t = YT_JUNK.sub(" ", t)
    return re.sub(r"\s{2,}", " ", t).strip()

def safe_name(s):
    return re.sub(r'[/\\:*?"<>|]', "_", s).strip()[:120]

def read_tags(path):
    tags = {"title": "", "artist": "", "album": ""}
    try:
        if path.suffix.lower() == ".mp3":
            a = MP3(path)
            t = a.tags or {}
            tags["title"]  = str(t.get("TIT2", "")).strip()
            tags["artist"] = str(t.get("TPE1", "")).strip()
            tags["album"]  = str(t.get("TALB", "")).strip()
        elif path.suffix.lower() == ".flac":
            a = FLAC(path)
            tags["title"]  = (a.get("title",  [""])[0]).strip()
            tags["artist"] = (a.get("artist", [""])[0]).strip()
            tags["album"]  = (a.get("album",  [""])[0]).strip()
    except Exception:
        pass
    return tags

def embed_art(path, data, mime="image/jpeg"):
    try:
        if path.suffix.lower() == ".mp3":
            a = MP3(path)
            if a.tags is None: a.add_tags()
            a.tags.delall("APIC")
            a.tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
            a.save()
        elif path.suffix.lower() == ".flac":
            a = FLAC(path)
            p = Picture(); p.type=3; p.mime=mime; p.desc="Cover"; p.data=data
            a.clear_pictures(); a.add_picture(p); a.save()
        return True
    except Exception as e:
        print(f"  ✗ Embed failed: {e}"); return False

def write_metadata(path, title, artist, album):
    try:
        if path.suffix.lower() == ".mp3":
            a = MP3(path)
            if a.tags is None: a.add_tags()
            a.tags["TIT2"] = TIT2(encoding=3, text=title)
            a.tags["TPE1"] = TPE1(encoding=3, text=artist)
            a.tags["TALB"] = TIT2(encoding=3, text=album) # TALB is Album
            a.save()
        elif path.suffix.lower() == ".flac":
            a = FLAC(path)
            a["title"] = title
            a["artist"] = artist
            a["album"] = album
            a.save()
    except Exception as e:
        print(f"  ✗ Tag write failed: {e}")

def fetch_caa(release_mbid):
    try:
        r = requests.get(f"{CAA_BASE}/{release_mbid}/front-500",
                         headers={"User-Agent": UA}, timeout=20, allow_redirects=True)
        if r.status_code == 200 and r.content:
            return r.content
    except Exception as e:
        print(f"  ✗ CAA error: {e}")
    return None

def extract_embedded_art(path):
    try:
        if path.suffix.lower() == ".mp3":
            a = MP3(path)
            if a.tags:
                for tag in a.tags.values():
                    if isinstance(tag, APIC): return tag.data
        elif path.suffix.lower() == ".flac":
            a = FLAC(path); pics = a.pictures
            if pics: return pics[0].data
    except Exception:
        pass
    return None

def search_mb(title, artist=""):
    """Search MusicBrainz. Returns dict or None."""
    parts = [f'recording:"{title}"']
    if artist:
        clean_artist = re.sub(r"\s*(ft\.|feat\.|&).*$", "", artist, flags=re.IGNORECASE).strip()
        if clean_artist: parts.append(f'artist:"{clean_artist}"')
    data = mb_get("recording", {"query": " AND ".join(parts), "limit": 5})
    if not data or not data.get("recordings"):
        return None
    for rec in data["recordings"]:
        if rec.get("score", 0) < 70:
            continue
        releases = rec.get("releases", [])
        # Prefer Studio Album releases
        for rel in releases:
            if rel.get("release-group", {}).get("primary-type") == "Album":
                return {
                    "title":   rec["title"],
                    "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                    "release": rel["id"],
                    "album":   rel["title"],
                }
        if releases:
            rel = releases[0]
            return {
                "title":   rec["title"],
                "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                "release": rel["id"],
                "album":   rel["title"],
            }
    return None

def process_album(album_dir, dry_run=False):
    """
    Processes files in a directory. If individual tracks are identified as 
    belonging to different albums, they are moved to proper Artist/Album folders.
    """
    print(f"\n{'[DRY RUN] ' if dry_run else ''}📂 Scanning: {album_dir.name}")
    audio_files = sorted(f for f in album_dir.iterdir()
                         if f.is_file() and f.suffix.lower() in AUDIO_EXTS)
    
    if not audio_files:
        return None

    for f in audio_files:
        print(f"\n  🎵  {f.name}")
        tags = read_tags(f)
        raw_title, raw_artist = tags["title"] or f.stem, tags["artist"]
        cleaned = clean_title(raw_title)

        # 1. Research Track
        mb = search_mb(cleaned, raw_artist)
        if not mb and " - " in raw_title:
            filename_artist = raw_title.split(" - ", 1)[0].replace("_", " ").strip()
            mb = search_mb(cleaned, filename_artist)
        if not mb: mb = search_mb(cleaned)

        if mb:
            print(f"      Match  : \"{mb['title']}\" by {mb['artist']} from album \"{mb['album']}\"")
            final_title, final_artist, final_album = mb['title'], mb['artist'], mb['album']
        else:
            print(f"      No match found. Using folder/tag info.")
            final_title, final_artist, final_album = cleaned, raw_artist or "Unknown Artist", album_dir.name

        # 2. Determine Destination
        # Pattern: Albums/Artist Name/Album Name/
        dest_dir = ALBUMS_DIR / safe_name(final_artist) / safe_name(final_album)
        
        prefix_m = re.match(r"^(\d+\s*[-_.]\s*)", f.stem)
        prefix = prefix_m.group(1) if prefix_m else ""
        new_filename = prefix + safe_name(final_title) + f.suffix
        new_path = dest_dir / new_filename

        if not dry_run:
            dest_dir.mkdir(parents=True, exist_ok=True)
            
            # 3. Fetch/Update Art in the NEW destination
            art_path = dest_dir / "cover.jpg"
            if not art_path.exists() and mb:
                print(f"      Art    : fetching…", end=" ", flush=True)
                art = fetch_caa(mb["release"])
                if art: 
                    art_path.write_bytes(art)
                    print(f"✓")
                else: print("✗")

            # 4. Update Tags & Relocate Audio
            write_metadata(f, final_title, final_artist, final_album)
            
            # 5. Handle Stems Relocation
            stem_key = re.sub(r"^\d+\s*[-_.]\s*", "", f.stem)
            old_stems_path = STEMS_DIR / (album_dir.name + "STEMS") / stem_key
            new_stems_root = STEMS_DIR / safe_name(final_artist) / (safe_name(final_album) + "STEMS")
            new_stems_path = new_stems_root / safe_name(final_title)

            if old_stems_path.exists():
                print(f"      Stems  : Relocating to {new_stems_path.relative_to(STEMS_DIR)}")
                new_stems_root.mkdir(parents=True, exist_ok=True)
                if old_stems_path != new_stems_path:
                    shutil.move(str(old_stems_path), str(new_stems_path))

            # Move audio file last
            if f != new_path:
                print(f"      Move   : → {new_path.relative_to(ALBUMS_DIR)}")
                if new_path.exists(): os.remove(new_path) # Overwrite if exact match exists
                shutil.move(str(f), str(new_path))

    # Clean up empty old folder (if it was an unsorted/playlist folder)
    if not dry_run and album_dir != ALBUMS_DIR:
        try:
            if not any(album_dir.iterdir()): 
                album_dir.rmdir()
                # Also try cleaning up stems folder
                old_stems_parent = STEMS_DIR / (album_dir.name + "STEMS")
                if old_stems_parent.exists() and not any(old_stems_parent.iterdir()):
                    old_stems_parent.rmdir()
        except: pass

    return None # Index rebuilding is handled in main() by scanning the whole dir

# ── Rebuild library.json ──────────────────────────────────────────────────────
def build_index(unused_albums_list):
    """Re-scans the entire Albums directory to build a fresh library.json"""
    print("\n🔍 Rebuilding library index...")
    albums = []
    
    # Walk through Artist/Album structure
    for artist_dir in sorted(ALBUMS_DIR.iterdir()):
        if not artist_dir.is_dir() or artist_dir.name.startswith('.'): continue
        
        for album_dir in sorted(artist_dir.iterdir()):
            if not album_dir.is_dir(): continue
            
            tracks = []
            cover_path = album_dir / "cover.jpg"
            
            for f in sorted(album_dir.iterdir()):
                if f.suffix.lower() not in AUDIO_EXTS: continue
                
                # Link stems based on new Artist/Album/Track structure
                stem_key = re.sub(r"^\d+\s*[-_.]\s*", "", f.stem)
                stems_dir = STEMS_DIR / artist_dir.name / (album_dir.name + "STEMS") / stem_key
                stems = {}
                if stems_dir.exists():
                    for sn in ("vocals", "drums", "bass", "other"):
                        for ext in (".mp3", ".flac", ".wav"):
                            sp = stems_dir / (sn + ext)
                            if sp.exists():
                                stems[sn] = str(sp.relative_to(MUSIC_ROOT))
                                break

                tracks.append({
                    "title": f.stem,
                    "filename": f.name,
                    "path": str(f.relative_to(MUSIC_ROOT)),
                    "format": f.suffix.lstrip(".").upper(),
                    "stems": stems
                })
            
            if tracks:
                albums.append({
                    "name": f"{artist_dir.name} - {album_dir.name}",
                    "path": str(album_dir.relative_to(MUSIC_ROOT)),
                    "art": str(cover_path.relative_to(MUSIC_ROOT)) if cover_path.exists() else "",
                    "tracks": tracks
                })

    library = {"albums": albums}
    INDEX_FILE.write_text(json.dumps(library, indent=2, ensure_ascii=False))
    print(f"✅ library.json updated with {len(albums)} albums.")
    
# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="SoundVault art fetcher + renamer")
    ap.add_argument("--dry-run",  action="store_true", help="Preview, no file changes")
    ap.add_argument("--album",    default="",           help="Process only this album name")
    ap.add_argument("--no-index", action="store_true", help="Skip library.json rebuild")
    args = ap.parse_args()

    if not ALBUMS_DIR.exists():
        sys.exit(f"Albums dir not found: {ALBUMS_DIR}\n"
                 "Set MUSIC_ROOT env var, e.g.:  export MUSIC_ROOT=~/MusicLibrary")

    print(f"🎵  SoundVault Art Fetcher")
    print(f"    root : {MUSIC_ROOT}")
    print(f"    mode : {'DRY RUN — no files modified' if args.dry_run else 'LIVE'}")

    dirs = sorted(d for d in ALBUMS_DIR.iterdir() if d.is_dir())
    if args.album:
        dirs = [d for d in dirs if args.album.lower() in d.name.lower()]
        if not dirs:
            sys.exit(f"No album matching: {args.album}")

    results = [process_album(d, dry_run=args.dry_run) for d in dirs]

    if not args.no_index and not args.dry_run:
        # Merge with any unprocessed albums already in library.json
        if args.album and INDEX_FILE.exists():
            try:
                existing = json.loads(INDEX_FILE.read_text()).get("albums", [])
                processed = {r["name"] for r in results if r}
                for ea in existing:
                    if ea["name"] not in processed:
                        results.append(ea)
                results.sort(key=lambda a: a["name"] if a else "")
            except Exception:
                pass
        build_index(results)
    elif args.dry_run:
        print(f"\n[DRY RUN] Would write {sum(1 for r in results if r)} albums to library.json")

if __name__ == "__main__":
    main()