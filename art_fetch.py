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

import argparse, json, os, re, sys, time
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

def write_title_tag(path, title, artist):
    try:
        a = MP3(path)
        if a.tags is None: a.add_tags()
        a.tags["TIT2"] = TIT2(encoding=3, text=title)
        if artist: a.tags["TPE1"] = TPE1(encoding=3, text=artist)
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

# ── Process one album directory ───────────────────────────────────────────────
def process_album(album_dir, dry_run=False):
    print(f"\n{'[DRY RUN] ' if dry_run else ''}📀  {album_dir.name}")
    audio_files = sorted(f for f in album_dir.iterdir()
                         if f.is_file() and f.suffix.lower() in AUDIO_EXTS)
    if not audio_files:
        print("  (no audio files)"); return None

    cover_path  = album_dir / "cover.jpg"
    cover_data  = None   # shared across all tracks in album
    tracks      = []

    for f in audio_files:
        print(f"\n  🎵  {f.name}")
        tags        = read_tags(f)
        raw_title   = tags["title"] or f.stem
        raw_artist  = tags["artist"]
        cleaned     = clean_title(raw_title)
        print(f"      title  : \"{raw_title}\" → \"{cleaned}\"")
        if raw_artist: print(f"      artist : {raw_artist}")

        # MusicBrainz lookup — try progressively broader queries
        mb = None
        if cleaned:
            print(f"      MB     : searching…", end=" ", flush=True)
            mb = search_mb(cleaned, raw_artist)

            # If tag artist looks like a YT channel, try artist from filename
            if not mb and " - " in raw_title:
                filename_artist = raw_title.split(" - ", 1)[0].replace("_", " ").strip()
                if filename_artist.lower() != (raw_artist or "").lower():
                    mb = search_mb(cleaned, filename_artist)

            # Last resort: title-only search
            if not mb:
                mb = search_mb(cleaned)

            if mb:
                print(f"✓  \"{mb['title']}\"  ({mb['album']})")
            else:
                print("✗  no match")

        official_title  = mb["title"]  if mb else cleaned
        official_artist = mb["artist"] if mb else raw_artist

        # Fetch cover art once per album
        if cover_data is None and mb:
            print(f"      art    : fetching…", end=" ", flush=True)
            art = fetch_caa(mb["release"])
            if art:
                cover_data = art
                print(f"✓  {len(art)//1024}KB")
                if not dry_run:
                    cover_path.write_bytes(art)
            else:
                print("✗  not in CAA")

        # Fallback: use already-embedded YouTube thumbnail
        if cover_data is None:
            embedded = extract_embedded_art(f)
            if embedded:
                cover_data = embedded
                print(f"      art    : using embedded YT thumbnail")
                if not dry_run:
                    cover_path.write_bytes(embedded)

        # Embed art + write tags
        if not dry_run:
            if cover_data:
                embed_art(f, cover_data)
            if official_title and official_title != raw_title and f.suffix.lower() == ".mp3":
                write_title_tag(f, official_title, official_artist)

        # Rename file
        prefix_m = re.match(r"^(\d+\s*[-_.]\s*)", f.stem)
        prefix   = prefix_m.group(1) if prefix_m else ""
        new_name = prefix + safe_name(official_title) + f.suffix
        new_path = f.parent / new_name

        if new_name != f.name:
            print(f"      rename : \"{f.name}\"")
            print(f"             → \"{new_name}\"")
            if not dry_run and not new_path.exists():
                f.rename(new_path)
                f = new_path

        # Stems lookup
        stem_key     = re.sub(r"^\d+\s*[-_.]\s*", "", f.stem)
        stems_dir    = STEMS_DIR / (album_dir.name + "STEMS") / stem_key
        stems        = {}
        for sn in ("vocals", "drums", "bass", "other"):
            for ext in (".mp3", ".flac", ".wav"):
                sp = stems_dir / (sn + ext)
                if sp.exists():
                    stems[sn] = str(sp.relative_to(MUSIC_ROOT)); break

        tracks.append({
            "title":    official_title,
            "filename": f.name,
            "path":     str(f.relative_to(MUSIC_ROOT)),
            "format":   f.suffix.lstrip(".").upper(),
            "stems":    stems,
        })

    art_rel = str(cover_path.relative_to(MUSIC_ROOT)) if cover_path.exists() else ""
    return {
        "name":   album_dir.name,
        "path":   str(album_dir.relative_to(MUSIC_ROOT)),
        "art":    art_rel,
        "tracks": tracks,
    }

# ── Rebuild library.json ──────────────────────────────────────────────────────
def build_index(albums):
    library = {"albums": [a for a in albums if a]}
    INDEX_FILE.write_text(json.dumps(library, indent=2, ensure_ascii=False))
    print(f"\n✅  library.json written  ({len(library['albums'])} albums)  →  {INDEX_FILE}")

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
