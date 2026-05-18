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
    from mutagen.id3 import ID3, APIC, TIT2, TPE1, TALB
    from mutagen.flac import FLAC, Picture
except ImportError:
    sys.exit("Missing: pip3 install mutagen")

# ── Config ────────────────────────────────────────────────────────────────────
MUSIC_ROOT = Path("/Volumes/XTRA/PYOB2026MAY/MusicLibrary")
ALBUMS_DIR = MUSIC_ROOT / "Albums"
STEMS_DIR  = MUSIC_ROOT / "STEMS"
INDEX_FILE = MUSIC_ROOT / "library.json"
AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".wav"}

ALL_ALBUMS = []

def load_all_albums():
    global ALL_ALBUMS
    ALL_ALBUMS = [
        "Live and Fucked Up",
        "Piece of Mind",
        "Hip Hop Deluxe 2001",
        "MTV Music History",
        "The Marshall Mathers LP (25th anniversary edition)",
        "The Death of Slim Shady (Coup de Grâce)",
        "The Marshall Mathers LP",
        "25th anniversary edition",
        "Marshall Mathers LP",
        "Da King of Da Rap Game??"
    ]
    if ALBUMS_DIR.exists():
        for artist_dir in ALBUMS_DIR.iterdir():
            if artist_dir.is_dir() and not artist_dir.name.startswith('.'):
                for alb_dir in artist_dir.iterdir():
                    if alb_dir.is_dir() and not alb_dir.name.startswith('.'):
                        if alb_dir.name not in ALL_ALBUMS:
                            ALL_ALBUMS.append(alb_dir.name)

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

def strip_album_prefix(title, album):
    if not album: return title
    norm_album = "".join(c.lower() for c in album if c.isalnum())
    if not norm_album: return title
    
    while True:
        norm_title = []
        indices = []
        for idx, char in enumerate(title):
            if char.isalnum():
                norm_title.append(char.lower())
                indices.append(idx)
        
        norm_title_str = "".join(norm_title)
        match_idx = norm_title_str.find(norm_album)
        if match_idx == -1:
            break
            
        orig_start = indices[match_idx]
        orig_end = indices[match_idx + len(norm_album) - 1]
        title = title[:orig_start] + title[orig_end + 1:]
        
    return re.sub(r"\s+", " ", title).strip("-_.,/\\ )}] ({[ ")

def extract_single_tag(tag_obj, album_hint=""):
    if not tag_obj:
        return ""
    text_list = tag_obj.text if hasattr(tag_obj, "text") else tag_obj
    if isinstance(text_list, str):
        text_list = [text_list]
    vals = [str(v).strip() for v in text_list]
    vals = [v for v in vals if v]
    if not vals:
        return ""
    if len(vals) == 1:
        return vals[0]
    if album_hint:
        norm_album = normalize_compare(album_hint)
        non_album_vals = [v for v in vals if normalize_compare(v) != norm_album]
        if non_album_vals:
            return non_album_vals[0]
    return vals[0]

def clean_title(raw, album_hint=""):
    t = raw.replace("_", " ")
    t = TRACK_NUM_RE.sub("", t)
    if " - " in t:
        # "Artist - Title" → keep after the dash
        t = t.split(" - ", 1)[1]
    t = YT_JUNK.sub(" ", t)
    
    if album_hint:
        t = strip_album_prefix(t, album_hint)
        
    for alb in ALL_ALBUMS:
        t = strip_album_prefix(t, alb)
            
    return re.sub(r"\s{2,}", " ", t).strip()

def clean_artist(artist):
    if not artist:
        return "Unknown Artist"
    # Remove common YouTube channel suffixes
    a = re.sub(r"(?i)\s*(?:music|vevo|-topic|official|youtube)\s*$", "", artist).strip()
    # Specific override: EminemMusic -> Eminem
    if a.lower() in ("eminemmusic", "eminem"):
        return "Eminem"
    return a

def normalize_compare(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())

def safe_name(s):
    # Strip null bytes and replace standard illegal characters
    s = s.replace("\x00", "")
    return re.sub(r'[/\\:*?"<>|]', "_", s).strip()[:120]

def read_tags(path):
    tags = {"title": "", "artist": "", "album": ""}
    try:
        album_hint = path.parent.name
        if path.suffix.lower() == ".mp3":
            a = MP3(path)
            t = a.tags or {}
            tags["title"]  = extract_single_tag(t.get("TIT2"), album_hint)
            tags["artist"] = extract_single_tag(t.get("TPE1"), album_hint)
            tags["album"]  = extract_single_tag(t.get("TALB"), album_hint)
        elif path.suffix.lower() == ".flac":
            a = FLAC(path)
            tags["title"]  = extract_single_tag(a.get("title"), album_hint)
            tags["artist"] = extract_single_tag(a.get("artist"), album_hint)
            tags["album"]  = extract_single_tag(a.get("album"), album_hint)
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
            a.tags["TALB"] = TALB(encoding=3, text=album) # TALB is Album
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

def search_mb(title, artist="", album_hint=""):
    """Search MusicBrainz. Returns dict or None."""
    # Clean the title for search by stripping featured artists to avoid search failures
    search_title = re.sub(r"[\(\[\{]?\s*(?:featuring|feat\.?|ft\.?)\s+[^\]\)\}]*[\)\]\}]?", "", title, flags=re.IGNORECASE)
    search_title = re.sub(r"\s+(?:featuring|feat\.?|ft\.?)\s+.*$", "", search_title, flags=re.IGNORECASE)
    search_title = re.sub(r"\s{2,}", " ", search_title).strip()

    parts = [f'recording:"{search_title}"']
    if artist:
        clean_art = clean_artist(artist)
        clean_art = re.sub(r"\s*(ft\.|feat\.|&).*$", "", clean_art, flags=re.IGNORECASE).strip()
        if clean_art: parts.append(f'artist:"{clean_art}"')
        
    # Try searching with release query parameter first (highly precise)
    data = None
    if album_hint:
        clean_alb = re.sub(r"[\(\[\{]?\s*(?:expanded|deluxe|remastered|anniversary|special|edition|version|mourner(?:’|')s)\s*[\)\]\}]?", "", album_hint, flags=re.IGNORECASE).strip()
        clean_alb = re.sub(r"\s{2,}", " ", clean_alb).strip()
        if clean_alb:
            precise_parts = parts + [f'release:"{clean_alb}"']
            limit = 5 if artist else 30
            data = mb_get("recording", {"query": " AND ".join(precise_parts), "limit": limit})
            
    # If precise search returned no results, fallback to searching without release filter
    if not data or not data.get("recordings"):
        limit = 5 if artist else 30
        data = mb_get("recording", {"query": " AND ".join(parts), "limit": limit})
        
    if not data or not data.get("recordings"):
        return None

    norm_hint = normalize_compare(album_hint) if album_hint else ""
    best_match = None

    for rec in data["recordings"]:
        if rec.get("score", 0) < 70:
            continue
        releases = rec.get("releases", [])

        # 1. First, check if there is a release matching the album_hint
        if norm_hint:
            for rel in releases:
                norm_rel = normalize_compare(rel.get("title", ""))
                # If perfect match or one contains the other, prefer this release group
                if norm_rel == norm_hint or (len(norm_rel) > 4 and (norm_rel in norm_hint or norm_hint in norm_rel)):
                    return {
                        "title":   rec["title"],
                        "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                        "release": rel["id"],
                        "album":   rel["title"],
                    }

        # 2. Prefer Studio Album releases (exclude Compilations/Live if possible)
        for rel in releases:
            rg = rel.get("release-group", {})
            primary = rg.get("primary-type")
            secondary = rg.get("secondary-types", [])
            is_official = primary == "Album" and not any(s in ("Compilation", "Live", "Remix", "Demo", "Soundtrack", "Spoken Word") for s in secondary)
            if is_official:
                best_match = {
                    "title":   rec["title"],
                    "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                    "release": rel["id"],
                    "album":   rel["title"],
                }
                if not norm_hint:
                    return best_match

    if best_match:
        return best_match

    # Fallback to the first release that is an Album
    for rec in data["recordings"]:
        if rec.get("score", 0) < 70:
            continue
        for rel in rec.get("releases", []):
            if rel.get("release-group", {}).get("primary-type") == "Album":
                return {
                    "title":   rec["title"],
                    "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                    "release": rel["id"],
                    "album":   rel["title"],
                }
                
        # Hard fallback to the absolute first release
        releases = rec.get("releases", [])
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
    print(f"\n{'[DRY RUN] ' if dry_run else ''}📂 Scanning: {album_dir.relative_to(ALBUMS_DIR)}")
    audio_files = sorted(f for f in album_dir.iterdir()
                         if f.is_file() and f.suffix.lower() in AUDIO_EXTS)
    
    if not audio_files:
        return None

    # Pass 1: Gather matches and find dominant artist/album
    results = []
    artist_counts = {}
    album_counts = {}

    album_hint = album_dir.name
    artist_hint = album_dir.parent.name if album_dir.parent != ALBUMS_DIR else ""

    for f in audio_files:
        tags = read_tags(f)
        raw_title, raw_artist = tags["title"] or f.stem, tags["artist"] or artist_hint
        cleaned = clean_title(raw_title, album_hint=album_hint)
        if tags.get("album"):
            cleaned = clean_title(cleaned, album_hint=tags["album"])

        mb = search_mb(cleaned, raw_artist, album_hint=album_hint)
        if not mb and " - " in raw_title:
            filename_artist = raw_title.split(" - ", 1)[0].replace("_", " ").strip()
            mb = search_mb(cleaned, filename_artist, album_hint=album_hint)
        if not mb:
            mb = search_mb(cleaned, album_hint=album_hint)

        if mb:
            art = clean_artist(mb["artist"])
            alb = mb["album"]
            artist_counts[art] = artist_counts.get(art, 0) + 1
            album_counts[alb] = album_counts.get(alb, 0) + 1
            results.append((f, cleaned, raw_artist, mb))
        else:
            results.append((f, cleaned, raw_artist, None))

    # Determine dominant artist and album in this directory
    dominant_artist = None
    if artist_counts:
        dominant_artist = max(artist_counts, key=artist_counts.get)
    elif artist_hint:
        dominant_artist = clean_artist(artist_hint)
    
    dominant_album = None
    if album_counts:
        dominant_album = max(album_counts, key=album_counts.get)
    else:
        dominant_album = album_dir.name

    # Pass 2: Process and relocate files
    for f, cleaned, raw_artist, mb in results:
        print(f"\n  🎵  {f.name}")
        
        if mb:
            print(f"      Match  : \"{mb['title']}\" by {mb['artist']} from album \"{mb['album']}\"")
            final_title = mb['title']
            final_artist = clean_artist(mb['artist'])
            final_album = mb['album']
        else:
            if dominant_artist and dominant_album:
                print(f"      No match found. Using dominant folder artist/album: \"{dominant_artist}\" - \"{dominant_album}\"")
                final_title, final_artist, final_album = cleaned, dominant_artist, dominant_album
            else:
                print(f"      No match found. Using folder/tag info.")
                final_title, final_artist, final_album = cleaned, clean_artist(raw_artist), album_dir.name

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
            
            if album_dir.parent == ALBUMS_DIR:
                old_stems_path = STEMS_DIR / (album_dir.name + "STEMS") / stem_key
            else:
                old_stems_path = STEMS_DIR / album_dir.parent.name / (album_dir.name + "STEMS") / stem_key
                
            new_stems_root = STEMS_DIR / safe_name(final_artist) / (safe_name(final_album) + "STEMS")
            new_stems_path = new_stems_root / safe_name(final_title)

            if old_stems_path.exists():
                print(f"      Stems  : Relocating to {new_stems_path.relative_to(STEMS_DIR)}")
                new_stems_root.mkdir(parents=True, exist_ok=True)
                if old_stems_path != new_stems_path:
                    try:
                        shutil.move(str(old_stems_path), str(new_stems_path))
                    except Exception as e:
                        print(f"      ⚠ Stems move failed: {e}")

            # Move audio file last
            if f != new_path:
                print(f"      Move   : → {new_path.relative_to(ALBUMS_DIR)}")
                if new_path.exists(): os.remove(new_path) # Overwrite if exact match exists
                shutil.move(str(f), str(new_path))

    # Clean up empty old folder (if it was an unsorted/playlist folder, robust to .DS_Store)
    if not dry_run and album_dir != ALBUMS_DIR:
        try:
            children = [c for c in album_dir.iterdir()]
            visible_children = [c for c in children if not c.name.startswith('.')]
            if not visible_children:
                for c in children:
                    if c.is_file(): c.unlink()
                album_dir.rmdir()
                
                if album_dir.parent == ALBUMS_DIR:
                    old_stems_parent = STEMS_DIR / (album_dir.name + "STEMS")
                else:
                    old_stems_parent = STEMS_DIR / album_dir.parent.name / (album_dir.name + "STEMS")
                if old_stems_parent.exists():
                    stems_children = [c for c in old_stems_parent.iterdir()]
                    stems_visible = [c for c in stems_children if not c.name.startswith('.')]
                    if not stems_visible:
                        for c in stems_children:
                            if c.is_file(): c.unlink()
                        old_stems_parent.rmdir()
        except: pass

    return None

# ── Rebuild library.json ──────────────────────────────────────────────────────
def build_index(unused_albums_list=None):
    """Re-scans the entire Albums directory to build a fresh library.json supporting both flat and nested layouts"""
    print("\n🔍 Rebuilding library index...")
    albums = []
    
    # Walk through ALL directories containing audio files under ALBUMS_DIR
    audio_dirs = []
    for dirpath, dirnames, filenames in os.walk(str(ALBUMS_DIR)):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        path = Path(dirpath)
        if any(f.suffix.lower() in AUDIO_EXTS for f in path.iterdir() if f.is_file()):
            audio_dirs.append(path)
            
    for album_dir in sorted(audio_dirs):
        tracks = []
        cover_path = album_dir / "cover.jpg"
        
        # Determine Artist & Album name from directory structure
        if album_dir.parent == ALBUMS_DIR:
            # Flat layout: Albums/AlbumName/
            album_name = album_dir.name
            artist_name = ""
            display_name = album_name
            stems_root_dir = STEMS_DIR / (album_dir.name + "STEMS")
        elif album_dir.parent.parent == ALBUMS_DIR:
            # Nested layout: Albums/ArtistName/AlbumName/
            album_name = album_dir.name
            artist_name = album_dir.parent.name
            display_name = f"{artist_name} - {album_name}"
            stems_root_dir = STEMS_DIR / artist_name / (album_name + "STEMS")
        else:
            album_name = album_dir.name
            artist_name = album_dir.parent.name
            display_name = f"{artist_name} - {album_name}"
            stems_root_dir = STEMS_DIR / artist_name / (album_name + "STEMS")
            
        for f in sorted(album_dir.iterdir()):
            if f.suffix.lower() not in AUDIO_EXTS: continue
            
            # Find stems
            stem_key = re.sub(r"^\d+\s*[-_.]\s*", "", f.stem)
            stems_dir = stems_root_dir / stem_key
            stems = {}
            if stems_dir.exists():
                for sn in ("vocals", "drums", "bass", "other"):
                    for ext in (".mp3", ".flac", ".wav"):
                        sp = stems_dir / (sn + ext)
                        if sp.exists():
                            stems[sn] = str(sp.relative_to(MUSIC_ROOT))
                            break

            tracks.append({
                "title": f.stem if album_dir.parent == ALBUMS_DIR else re.sub(r"^\d+\s*[-_.]\s*", "", f.stem),
                "filename": f.name,
                "path": str(f.relative_to(MUSIC_ROOT)),
                "format": f.suffix.lstrip(".").upper(),
                "stems": stems
            })
            
        if tracks:
            albums.append({
                "name": display_name,
                "path": str(album_dir.relative_to(MUSIC_ROOT)),
                "art": str(cover_path.relative_to(MUSIC_ROOT)) if cover_path.exists() else "",
                "tracks": tracks
            })

    library = {"albums": albums}
    INDEX_FILE.write_text(json.dumps(library, indent=2, ensure_ascii=False))
    print(f"✅ library.json updated with {len(albums)} albums.")

def cleanup_empty_dirs(root_dir):
    """Recursively deletes empty directories (handling macOS hidden files like .DS_Store) inside root_dir"""
    if not root_dir.exists(): return
    for dirpath, dirnames, filenames in os.walk(str(root_dir), topdown=False):
        path = Path(dirpath)
        if path == root_dir: continue
        try:
            children = [c for c in path.iterdir()]
            visible_children = [c for c in children if not c.name.startswith('.')]
            if not visible_children:
                for c in children:
                    if c.is_file(): c.unlink()
                path.rmdir()
                print(f"      Cleaned empty directory: {path.relative_to(root_dir)}")
        except Exception:
            pass

def cleanup_orphaned_dirs(albums_dir, stems_dir):
    """Deletes legacy directories that no longer contain any audio files (cleaning left-over cover.jpg files)"""
    if albums_dir.exists():
        audio_folders = set()
        for dirpath, dirnames, filenames in os.walk(str(albums_dir)):
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
            for f in filenames:
                if Path(f).suffix.lower() in AUDIO_EXTS:
                    audio_folders.add(Path(dirpath))
                    parent = Path(dirpath).parent
                    while parent != albums_dir and parent != albums_dir.parent:
                        audio_folders.add(parent)
                        parent = parent.parent
        for dirpath, dirnames, filenames in os.walk(str(albums_dir), topdown=False):
            path = Path(dirpath)
            if path == albums_dir: continue
            if path not in audio_folders:
                try:
                    for f in path.iterdir():
                        if f.is_file(): f.unlink()
                    path.rmdir()
                    print(f"      Cleaned legacy folder containing no audio: {path.relative_to(albums_dir)}")
                except: pass

    if stems_dir.exists():
        stems_folders = set()
        for dirpath, dirnames, filenames in os.walk(str(stems_dir)):
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
            for f in filenames:
                if Path(f).suffix.lower() in AUDIO_EXTS:
                    stems_folders.add(Path(dirpath))
                    parent = Path(dirpath).parent
                    while parent != stems_dir and parent != stems_dir.parent:
                        stems_folders.add(parent)
                        parent = parent.parent
        for dirpath, dirnames, filenames in os.walk(str(stems_dir), topdown=False):
            path = Path(dirpath)
            if path == stems_dir: continue
            if path not in stems_folders:
                try:
                    for f in path.iterdir():
                        if f.is_file(): f.unlink()
                    path.rmdir()
                    print(f"      Cleaned legacy stems folder containing no stems: {path.relative_to(stems_dir)}")
                except: pass

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

    load_all_albums()

    print(f"🎵  SoundVault Art Fetcher")
    print(f"    root : {MUSIC_ROOT}")
    print(f"    mode : {'DRY RUN — no files modified' if args.dry_run else 'LIVE'}")

    # Find all directories that contain audio files recursively under ALBUMS_DIR
    dirs = []
    for dirpath, dirnames, filenames in os.walk(str(ALBUMS_DIR)):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        path = Path(dirpath)
        if any(f.suffix.lower() in AUDIO_EXTS for f in path.iterdir() if f.is_file()):
            dirs.append(path)
    dirs = sorted(dirs)

    if args.album:
        dirs = [d for d in dirs if args.album.lower() in d.name.lower()]
        if not dirs:
            sys.exit(f"No album matching: {args.album}")

    results = []
    for d in dirs:
        if d.exists():
            results.append(process_album(d, dry_run=args.dry_run))

    if not args.no_index and not args.dry_run:
        build_index()
        cleanup_orphaned_dirs(ALBUMS_DIR, STEMS_DIR)
        cleanup_empty_dirs(ALBUMS_DIR)
        cleanup_empty_dirs(STEMS_DIR)
    elif args.dry_run:
        print(f"\n[DRY RUN] Would scan and rebuild library.json")

if __name__ == "__main__":
    main()