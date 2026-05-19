#!/usr/bin/env python3.11
"""
SoundVault — art_fetch.py
=========================
Fetches official album art from MusicBrainz/Cover Art Archive,
renames tracks to official titles, embeds art into tags,
and rebuilds library.json.

Now enhanced with sequential search fallbacks:
1. MusicBrainz (Official exact matching)
2. Wikipedia Search API (parsing song/single Infoboxes)
3. DuckDuckGo Search (locating matching Wikipedia pages as Google/DDG fallback)

Leaves the track name/metadata alone if no match is found (only strips YouTube junk).

Usage:
  python3 art_fetch.py                     # all albums
  python3 art_fetch.py --dry-run           # preview only
  python3 art_fetch.py --album "2Pac"      # one album
  python3 art_fetch.py --no-index          # skip library.json rebuild

Requirements:
  pip3 install mutagen requests
"""

import argparse
import json
import os
import re
import sys
import time
import shutil
import urllib.parse
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
TRACK_NUM_RE = re.compile(r"^\d+\s*[-_.]\s*")

def clean_youtube_junk(text):
    """
    Strips common YouTube video junk (like lyrics video, Audio Only, visualizer, official audio, etc.)
    from a track title, keeping only the clean title itself.
    """
    t = text.replace("_", " ")
    t = TRACK_NUM_RE.sub("", t)
    
    # Common YouTube video junk terms
    junk_keywords = [
        r"official\s+music\s+video", r"official\s+video", r"official\s+audio",
        r"music\s+video", r"lyric\s+video", r"lyrics\s+video", r"official\s+lyrics\s+video",
        r"audio\s+only", r"official\s+audio\s+only", r"visualizer", r"explicit", r"clean\s+version",
        r"dirty\s+version", r"radio\s+edit", r"full\s+song", r"full\s+version", r"video\s+clip",
        r"official\s+video\s+clip", r"lyrics", r"lyric", r"audio", r"video", r"official",
        r"hd", r"hq", r"4k", r"1080p", r"720p", r"remastered", r"remaster"
    ]
    
    # 1. Strip brackets/braces/parentheses enclosing any of the junk keywords
    pattern_brackets = re.compile(
        r"[\(\[\{]\s*[^)\]}]*(?:" + "|".join(junk_keywords) + r")[^)\]}]*\s*[\)\]\}]",
        re.IGNORECASE
    )
    t = pattern_brackets.sub("", t)
    
    # 2. Strip stand-alone junk keywords from anywhere else in the title
    pattern_standalone = re.compile(
        r"\b(?:" + "|".join(junk_keywords) + r")\b",
        re.IGNORECASE
    )
    t = pattern_standalone.sub("", t)
    
    # Clean up double/excess whitespace and dangling punctuation
    t = re.sub(r"\s+", " ", t).strip()
    t = t.strip("-_.,/\\ )}] ({[ &")
    t = re.sub(r"\s{2,}", " ", t).strip()
    return t

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

def parse_filename(stem):
    """
    Parses a filename stem to extract artist and title.
    Returns (cleaned_title, extracted_artist or "")
    """
    # Replace underscores with spaces to handle --restrict-filenames
    s = stem.replace("_", " ").strip()

    # 1. Strip leading track number prefix
    s = re.sub(r"^\d+\s*[-_.]\s*", "", s).strip()
    s = re.sub(r"^\d+\s+", "", s).strip()
    
    # 2. Strip featured artist suffixes from the filename
    s = re.sub(r"(?i)\s+(?:featuring|feat\.?|ft\.?)\s+.*$", "", s).strip()
    
    # 3. Strip common YouTube junk
    s = clean_youtube_junk(s)
    
    # Strip helper words
    s = re.sub(r"(?i)\s+(?:with|by|feat\.?|ft\.?|featuring|and|&)\s*$", "", s).strip()
    s = re.sub(r"\s{2,}", " ", s).strip()
    
    artist = ""
    title = s
    
    for separator in (" - ", " – ", " — "):
        if separator in s:
            parts = s.split(separator, 1)
            artist = parts[0].strip()
            title = parts[1].strip()
            break
    else:
        match = re.search(r"\s*-\s*", s)
        if match:
            idx = match.start()
            left = s[:idx].strip()
            right = s[idx + len(match.group(0)):].strip()
            if left and right and not (left.lower() == "blink" and right.lower().startswith("182")):
                artist = left
                title = right

    if artist:
        artist = clean_artist(artist)
    
    title = title.strip("-_.,/\\ )}] ({[ &")
    title = re.sub(r"\s{2,}", " ", title).strip()
    return title, artist

def clean_title(raw, album_hint=""):
    t = raw.replace("_", " ")
    t = TRACK_NUM_RE.sub("", t)
    if " - " in t:
        t = t.split(" - ", 1)[1]
    t = clean_youtube_junk(t)
    
    if album_hint:
        t = strip_album_prefix(t, album_hint)
        
    for alb in ALL_ALBUMS:
        t = strip_album_prefix(t, alb)
            
    return re.sub(r"\s{2,}", " ", t).strip()

def clean_artist(artist):
    if not artist:
        return "Unknown Artist"
    a = re.sub(r"(?i)\s*(?:music|vevo|-topic|official|youtube)\s*$", "", artist).strip()
    norm = re.sub(r'[^a-z0-9]', '', a.lower())
    if norm in ("eminemmusic", "eminem"):
        return "Eminem"
    if norm == "megadeath":
        return "Megadeth"
    if norm == "blink182":
        return "blink-182"
    return a

def normalize_compare(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())

def safe_name(s):
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
            a.tags["TALB"] = TALB(encoding=3, text=album)
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

def fetch_caa_group(rg_mbid):
    try:
        r = requests.get(f"https://coverartarchive.org/release-group/{rg_mbid}/front-500",
                         headers={"User-Agent": UA}, timeout=20, allow_redirects=True)
        if r.status_code == 200 and r.content:
            return r.content
    except Exception:
        pass
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

def is_version_mismatch(query, candidate):
    query_norm = query.lower()
    candidate_norm = candidate.lower()
    
    query_norm = re.sub(r"[^a-z0-9\s]", "", query_norm)
    candidate_norm = re.sub(r"[^a-z0-9\s]", "", candidate_norm)
    
    keywords = ["remix", "acoustic", "live", "instrumental", "dub", "cover", "tribute", "karaoke", "demo", "slowed", "reverb", "sped up"]
    for kw in keywords:
        if re.search(r'\b' + re.escape(kw) + r'\b', candidate_norm) and not re.search(r'\b' + re.escape(kw) + r'\b', query_norm):
            return True
    return False

def is_exact_match(title1, artist1, title2, artist2):
    """
    Enforces that candidate metadata must be an exact, high-quality, and official
    match to the source title and artist.
    """
    t1 = normalize_compare(title1)
    t2 = normalize_compare(title2)
    a1 = normalize_compare(artist1) if artist1 else ""
    a2 = normalize_compare(artist2) if artist2 else ""
    
    if not t1 or not t2:
        return False
        
    # Check for direct title equality
    if t1 == t2:
        if a1 and a2:
            return a1 == a2 or a1 in a2 or a2 in a1
        return True
        
    # Allow close substring matches for longer titles to accommodate slight variations
    if len(t1) > 4 and len(t2) > 4:
        if t1 in t2 or t2 in t1:
            if a1 and a2:
                return a1 == a2 or a1 in a2 or a2 in a1
            return True
            
    return False

# ── Search Engines & Fallbacks ────────────────────────────────────────────────

def search_mb(title, artist="", album_hint=""):
    """Search MusicBrainz. Returns dict or None."""
    search_title = re.sub(r"[\(\[\{]?\s*(?:featuring|feat\.?|ft\.?)\s+[^\]\)\}]*[\)\]\}]?", "", title, flags=re.IGNORECASE)
    search_title = re.sub(r"\s+(?:featuring|feat\.?|ft\.?)\s+.*$", "", search_title, flags=re.IGNORECASE)
    search_title = re.sub(r"\s{2,}", " ", search_title).strip()

    parts = [f'recording:"{search_title}"']
    if artist:
        clean_art = clean_artist(artist)
        clean_art = re.sub(r"\s*(ft\.|feat\.|&).*$", "", clean_art, flags=re.IGNORECASE).strip()
        if clean_art: parts.append(f'artist:"{clean_art}"')
        
    data = None
    if album_hint:
        clean_alb = re.sub(r"[\(\[\{]?\s*(?:expanded|deluxe|remastered|anniversary|special|edition|version|mourner(?:’|')s)\s*[\)\]\}]?", "", album_hint, flags=re.IGNORECASE).strip()
        clean_alb = re.sub(r"\s{2,}", " ", clean_alb).strip()
        if clean_alb:
            precise_parts = parts + [f'release:"{clean_alb}"']
            limit = 5 if artist else 30
            data = mb_get("recording", {"query": " AND ".join(precise_parts), "limit": limit})
            
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
            
        if is_version_mismatch(title, rec["title"]):
            continue
        releases = rec.get("releases", [])

        if norm_hint:
            for rel in releases:
                norm_rel = normalize_compare(rel.get("title", ""))
                if norm_rel == norm_hint or (len(norm_rel) > 4 and (norm_rel in norm_hint or norm_hint in norm_rel)):
                    return {
                        "title":   rec["title"],
                        "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                        "release": rel["id"],
                        "album":   rel["title"],
                        "release_group": rel.get("release-group", {}).get("id"),
                    }

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
                    "release_group": rg.get("id"),
                }
                if not norm_hint:
                    return best_match

    if best_match:
        return best_match

    for rec in data["recordings"]:
        if rec.get("score", 0) < 70:
            continue
        for rel in rec.get("releases", []):
            rg = rel.get("release-group", {})
            if rg.get("primary-type") == "Album":
                return {
                    "title":   rec["title"],
                    "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                    "release": rel["id"],
                    "album":   rel["title"],
                    "release_group": rg.get("id"),
                }
                
        releases = rec.get("releases", [])
        if releases:
            rel = releases[0]
            return {
                "title":   rec["title"],
                "artist":  (rec.get("artist-credit") or [{}])[0].get("artist", {}).get("name", artist),
                "release": rel["id"],
                "album":   rel["title"],
                "release_group": rel.get("release-group", {}).get("id"),
            }
            
    return None

def parse_wikipedia_infobox(wikitext):
    """
    Parses wikitext song/single/album/track infobox to extract key fields.
    """
    if not wikitext:
        return None
    
    # Try to find a matching infobox template
    match = re.search(r"\{\{Infobox\s+(song|single|album|music\s+track|track)\b", wikitext, re.IGNORECASE)
    if not match:
        return None
        
    start_idx = match.start()
    content = wikitext[start_idx:start_idx+12000]
    
    info = {}
    for line in content.split("\n"):
        if line.strip() == "}}":
            break
        m = re.match(r"^\s*\|\s*([a-zA-Z0-9_\-]+)\s*=\s*(.+)$", line)
        if m:
            key = m.group(1).strip().lower()
            val = m.group(2).strip()
            
            # Remove wikitext formatting
            val = re.sub(r"\[\[([^\|\]]+)\]\]", r"\1", val)
            val = re.sub(r"\[\[[^\|\]]+\|([^\]]+)\]\]", r"\1", val)
            val = re.sub(r"<!--.*?-->", "", val)
            val = re.sub(r"<[^>]+>", "", val)
            val = re.sub(r"\{\{.*?\}\}", "", val)
            val = val.strip("-_.,/\\ )}] ({[ &'")
            info[key] = val
            
    return info

def search_wikipedia(title, artist=""):
    """
    Search Wikipedia for official metadata.
    """
    query_str = f"{artist} {title} song" if artist else f"{title} song"
    print(f"      Wiki   : Searching Wikipedia for \"{query_str}\"…")
    
    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query_str,
        "format": "json",
        "limit": 3
    }
    
    try:
        r = requests.get(url, params=params, headers={"User-Agent": UA}, timeout=10)
        if r.status_code != 200:
            return None
        
        data = r.json()
        results = data.get("query", {}).get("search", [])
        if not results:
            return None
            
        for res in results:
            page_title = res.get("title")
            raw_url = "https://en.wikipedia.org/w/index.php"
            r_raw = requests.get(raw_url, params={"title": page_title, "action": "raw"},
                                 headers={"User-Agent": UA}, timeout=10)
            if r_raw.status_code != 200 or not r_raw.text:
                continue
                
            info = parse_wikipedia_infobox(r_raw.text)
            if info:
                info_name = info.get("name") or page_title
                info_artist = info.get("artist") or artist or ""
                info_album = info.get("album") or "Single"
                
                info_name = re.sub(r"\s*\([^)]*\)", "", info_name).strip()
                info_artist = re.sub(r"\s*\([^)]*\)", "", info_artist).strip()
                info_album = re.sub(r"\s*\([^)]*\)", "", info_album).strip()
                
                if is_exact_match(title, artist, info_name, info_artist):
                    return {
                        "title": info_name,
                        "artist": info_artist,
                        "album": info_album,
                        "source": "Wikipedia",
                        "wiki_page": page_title
                    }
    except Exception as e:
        print(f"      Wiki   : Error: {e}")
    return None

def search_duckduckgo_google(title, artist=""):
    """
    Fallback DuckDuckGo Search to locate matching Wikipedia article.
    """
    query_str = f"{artist} {title} song wikipedia" if artist else f"{title} song wikipedia"
    print(f"      DDG    : Searching DDG for \"{query_str}\"…")
    
    url = "https://html.duckduckgo.com/html/"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    }
    
    try:
        r = requests.get(url, params={"q": query_str}, headers=headers, timeout=10)
        if r.status_code != 200:
            return None
            
        # Scan DDG response for wikipedia URLs
        wiki_titles = []
        matches = re.finditer(r'en\.wikipedia\.org/wiki/([a-zA-Z0-9_\-\%\(\)]+)', r.text)
        for m in matches:
            encoded_title = m.group(1)
            page_title = urllib.parse.unquote(encoded_title).replace("_", " ")
            page_title = page_title.split("#")[0].split("?")[0]
            if page_title and page_title not in wiki_titles:
                wiki_titles.append(page_title)
                
        for page_title in wiki_titles[:3]:
            raw_url = "https://en.wikipedia.org/w/index.php"
            r_raw = requests.get(raw_url, params={"title": page_title, "action": "raw"},
                                 headers={"User-Agent": UA}, timeout=10)
            if r_raw.status_code != 200 or not r_raw.text:
                continue
                
            info = parse_wikipedia_infobox(r_raw.text)
            if info:
                info_name = info.get("name") or page_title
                info_artist = info.get("artist") or artist or ""
                info_album = info.get("album") or "Single"
                
                info_name = re.sub(r"\s*\([^)]*\)", "", info_name).strip()
                info_artist = re.sub(r"\s*\([^)]*\)", "", info_artist).strip()
                info_album = re.sub(r"\s*\([^)]*\)", "", info_album).strip()
                
                if is_exact_match(title, artist, info_name, info_artist):
                    return {
                        "title": info_name,
                        "artist": info_artist,
                        "album": info_album,
                        "source": "DuckDuckGo",
                        "wiki_page": page_title
                    }
    except Exception as e:
        print(f"      DDG    : Error: {e}")
    return None

def fetch_artist_image(artist_name):
    """
    Search Wikipedia for the artist page and get the main thumbnail image (headshot).
    """
    if not artist_name or artist_name.lower() in ("unknown artist", "various artists"):
        return None
        
    url = "https://en.wikipedia.org/w/api.php"
    search_params = {
        "action": "query",
        "list": "search",
        "srsearch": f"{artist_name} musician OR band",
        "format": "json",
        "limit": 1
    }
    try:
        r = requests.get(url, params=search_params, headers={"User-Agent": UA}, timeout=10)
        if r.status_code != 200:
            return None
            
        data = r.json()
        results = data.get("query", {}).get("search", [])
        if not results:
            return None
        page_title = results[0]["title"]
        
        img_params = {
            "action": "query",
            "prop": "pageimages",
            "titles": page_title,
            "pithumbsize": 800,
            "format": "json"
        }
        r_img = requests.get(url, params=img_params, headers={"User-Agent": UA}, timeout=10)
        img_data = r_img.json()
        pages = img_data.get("query", {}).get("pages", {})
        for page_id, page_info in pages.items():
            if "thumbnail" in page_info:
                return page_info["thumbnail"]["source"]
    except Exception as e:
        print(f"      Artist : Error fetching image: {e}")
    return None

def find_official_match(title, artist="", album_hint=""):
    """
    Orchestrates the sequential search pipeline (MusicBrainz -> Wikipedia -> DDG).
    """
    # 1. Try MusicBrainz
    mb = search_mb(title, artist, album_hint)
    if not mb and " - " in title:
        parts = title.split(" - ", 1)
        mb = search_mb(parts[1], parts[0], album_hint)
    if not mb:
        mb = search_mb(title, album_hint=album_hint)
        
    if mb and is_exact_match(title, artist, mb["title"], mb["artist"]):
        return {
            "title": mb["title"],
            "artist": mb["artist"],
            "album": mb["album"],
            "release": mb["release"],
            "release_group": mb.get("release_group") or mb.get("release-group"),
            "source": "MusicBrainz"
        }
        
    # 2. Try Wikipedia
    wiki = search_wikipedia(title, artist)
    if wiki:
        # Cross-reference with MB to get cover art release identifier
        mb_wiki = search_mb(wiki["title"], wiki["artist"], wiki["album"])
        return {
            "title": wiki["title"],
            "artist": wiki["artist"],
            "album": wiki["album"],
            "release": mb_wiki["release"] if mb_wiki else None,
            "release_group": (mb_wiki.get("release_group") or mb_wiki.get("release-group")) if mb_wiki else None,
            "source": "Wikipedia"
        }
        
    # 3. Try Google/DuckDuckGo
    ddg = search_duckduckgo_google(title, artist)
    if ddg:
        mb_ddg = search_mb(ddg["title"], ddg["artist"], ddg["album"])
        return {
            "title": ddg["title"],
            "artist": ddg["artist"],
            "album": ddg["album"],
            "release": mb_ddg["release"] if mb_ddg else None,
            "release_group": (mb_ddg.get("release_group") or mb_ddg.get("release-group")) if mb_ddg else None,
            "source": "DuckDuckGo"
        }
        
    return None

# ── Album Processing ──────────────────────────────────────────────────────────

def process_album(album_dir, dry_run=False):
    """
    Processes files in a directory. Renames matching tracks and leaves unmatched tracks alone.
    """
    print(f"\n{'[DRY RUN] ' if dry_run else ''}📂 Scanning: {album_dir.relative_to(ALBUMS_DIR)}")
    audio_files = sorted(f for f in album_dir.iterdir()
                         if f.is_file() and f.suffix.lower() in AUDIO_EXTS)
    
    if not audio_files:
        return None

    results = []
    album_hint = album_dir.name
    artist_hint = album_dir.parent.name if album_dir.parent != ALBUMS_DIR else ""

    for f in audio_files:
        fn_title, fn_artist = parse_filename(f.stem)
        tags = read_tags(f)
        
        trustworthy_artist_hint = artist_hint if artist_hint and artist_hint.lower() not in ("albums", "unknown artist", "single", "stems") else ""
        raw_artist = fn_artist or tags["artist"] or trustworthy_artist_hint
        raw_title = fn_title or tags["title"] or f.stem
        
        cleaned = clean_youtube_junk(raw_title)
        if album_hint:
            cleaned = strip_album_prefix(cleaned, album_hint)
        if tags.get("album"):
            cleaned = strip_album_prefix(cleaned, tags["album"])

        match = find_official_match(cleaned, raw_artist, album_hint=album_hint)
        results.append((f, cleaned, raw_artist, match))

    for f, cleaned, raw_artist, match in results:
        print(f"\n  🎵  {f.name}")
        
        if match:
            print(f"      Match  : \"{match['title']}\" by {match['artist']} from album \"{match['album']}\" (via {match['source']})")
            final_title = match['title']
            final_artist = clean_artist(match['artist'])
            final_album = match['album']
        else:
            # Leave the name alone! Only strip YouTube junk.
            print(f"      No match found. Leaving name alone (cleaning YouTube junk).")
            final_title = cleaned
            final_artist = clean_artist(raw_artist) if raw_artist else (artist_hint or "Unknown Artist")
            final_album = album_hint

        # Avoid redundant renaming when possible
        if album_dir.name and normalize_compare(final_album) == normalize_compare(album_dir.name):
            final_album = album_dir.name
            
        if album_dir.parent != ALBUMS_DIR and album_dir.parent.name:
            if normalize_compare(final_artist) == normalize_compare(album_dir.parent.name):
                final_artist = album_dir.parent.name

        # Determine Destination Directory
        dest_dir = ALBUMS_DIR / safe_name(final_artist) / safe_name(final_album)
        
        prefix_m = re.match(r"^(\d+\s*[-_.]\s*)", f.stem)
        prefix = prefix_m.group(1) if prefix_m else ""
        new_filename = prefix + safe_name(final_title) + f.suffix
        new_path = dest_dir / new_filename

        if not dry_run:
            if not f.exists():
                print(f"      ⚠ Error: Source file not found: {f}")
                continue

            dest_dir.mkdir(parents=True, exist_ok=True)
            
            # Fetch / embed cover art
            art_path = dest_dir / "cover.jpg"
            art_data = None
            if not art_path.exists() and match and match.get("release"):
                print(f"      Art    : fetching…", end=" ", flush=True)
                art_data = fetch_caa(match["release"])
                if not art_data and match.get("release_group"):
                    art_data = fetch_caa_group(match["release_group"])
                
                if art_data: 
                    art_path.write_bytes(art_data)
                    print(f"✓")
                else: 
                    print("✗")
            elif art_path.exists():
                try:
                    art_data = art_path.read_bytes()
                except Exception:
                    pass

            # Update Metadata Tags
            write_metadata(f, final_title, final_artist, final_album)
            
            if art_data:
                embed_art(f, art_data)
                
            # Fetch Artist Image
            artist_dir = ALBUMS_DIR / safe_name(final_artist)
            artist_dir.mkdir(parents=True, exist_ok=True)
            artist_img_path = artist_dir / "artist.jpg"
            if not artist_img_path.exists():
                print(f"      Artist : fetching headshot…", end=" ", flush=True)
                img_url = fetch_artist_image(final_artist)
                if img_url:
                    try:
                        r_img = requests.get(img_url, headers={"User-Agent": UA}, timeout=15)
                        if r_img.status_code == 200:
                            artist_img_path.write_bytes(r_img.content)
                            print(f"✓")
                        else:
                            print("✗")
                    except Exception:
                        print("✗")
                else:
                    print("✗")
            
            # Relocate Stems (if any exist from prior stems creation)
            stem_key = re.sub(r"^\d+\s*[-_.]\s*", "", f.stem)
            
            if album_dir.parent == ALBUMS_DIR:
                old_stems_path = STEMS_DIR / (album_dir.name + "STEMS") / stem_key
            else:
                old_stems_path = STEMS_DIR / album_dir.parent.name / (album_dir.name + "STEMS") / stem_key
                
            new_stems_root = STEMS_DIR / safe_name(final_artist) / (safe_name(final_album) + "STEMS")
            new_stems_path = new_stems_root / safe_name(final_title)

            if old_stems_path.exists():
                is_stems_same = False
                if new_stems_path.exists():
                    try:
                        is_stems_same = os.path.samefile(old_stems_path, new_stems_path)
                    except Exception:
                        pass
                
                try:
                    if not is_stems_same:
                        print(f"      Stems  : Relocating to {new_stems_path.relative_to(STEMS_DIR)}")
                        new_stems_root.mkdir(parents=True, exist_ok=True)
                        if old_stems_path != new_stems_path:
                            shutil.move(str(old_stems_path), str(new_stems_path))
                    else:
                        if old_stems_path.name != new_stems_path.name:
                            print(f"      Stems  : Rename (case change) {old_stems_path.name} → {new_stems_path.name}")
                            temp_stems = old_stems_path.with_name(old_stems_path.name + ".tmp_rename")
                            if temp_stems.exists():
                                shutil.rmtree(temp_stems)
                            os.rename(old_stems_path, temp_stems)
                            os.rename(temp_stems, new_stems_path)
                except Exception as e:
                    print(f"      ⚠ Stems move failed: {e}")

            # Relocate audio file last
            if f != new_path:
                is_same = False
                if f.exists() and new_path.exists():
                    try:
                        is_same = os.path.samefile(f, new_path)
                    except Exception:
                        pass

                try:
                    if is_same:
                        if f.name != new_filename:
                            print(f"      Rename (case change): {f.name} → {new_filename}")
                            temp_path = f.with_name(f.name + ".tmp_rename")
                            if temp_path.exists():
                                os.remove(temp_path)
                            os.rename(f, temp_path)
                            os.rename(temp_path, new_path)
                        else:
                            print(f"      Move   : Already in place (case-insensitive match)")
                    else:
                        print(f"      Move   : → {new_path.relative_to(ALBUMS_DIR)}")
                        if new_path.exists():
                            os.remove(new_path)
                        if f.exists():
                            shutil.move(str(f), str(new_path))
                except Exception as e:
                    print(f"      ⚠ Move failed: {e}")

    # Clean up empty parent directories
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
        except:
            pass

    return None

# ── Rebuild library.json ──────────────────────────────────────────────────────

def build_index(unused_albums_list=None):
    print("\n🔍 Rebuilding library index...")
    albums = []
    
    audio_dirs = []
    for dirpath, dirnames, filenames in os.walk(str(ALBUMS_DIR)):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        path = Path(dirpath)
        if any(f.suffix.lower() in AUDIO_EXTS for f in path.iterdir() if f.is_file()):
            audio_dirs.append(path)
            
    for album_dir in sorted(audio_dirs):
        tracks = []
        cover_path = album_dir / "cover.jpg"
        
        if album_dir.parent == ALBUMS_DIR:
            album_name = album_dir.name
            artist_name = ""
            display_name = album_name
            stems_root_dir = STEMS_DIR / (album_dir.name + "STEMS")
            artist_img_path = album_dir / "artist.jpg"
        elif album_dir.parent.parent == ALBUMS_DIR:
            album_name = album_dir.name
            artist_name = album_dir.parent.name
            display_name = f"{artist_name} - {album_name}"
            stems_root_dir = STEMS_DIR / artist_name / (album_name + "STEMS")
            artist_img_path = album_dir.parent / "artist.jpg"
        else:
            album_name = album_dir.name
            artist_name = album_dir.parent.name
            display_name = f"{artist_name} - {album_name}"
            stems_root_dir = STEMS_DIR / artist_name / (album_name + "STEMS")
            artist_img_path = album_dir.parent / "artist.jpg"
            
        for f in sorted(album_dir.iterdir()):
            if f.suffix.lower() not in AUDIO_EXTS: continue
            
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
                "artist_art": str(artist_img_path.relative_to(MUSIC_ROOT)) if artist_img_path.exists() else "",
                "tracks": tracks
            })

    library = {"albums": albums}
    INDEX_FILE.write_text(json.dumps(library, indent=2, ensure_ascii=False))
    print(f"✅ library.json updated with {len(albums)} albums.")

def cleanup_empty_dirs(root_dir):
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
                except:
                    pass

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
                except:
                    pass

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

    print(f"🎵  SoundVault Art Fetcher & Organiser")
    print(f"    root : {MUSIC_ROOT}")
    print(f"    mode : {'DRY RUN — no files modified' if args.dry_run else 'LIVE'}")

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
            sys.exit(f"No album directory matching: {args.album}")

    for d in dirs:
        if d.exists():
            process_album(d, dry_run=args.dry_run)

    if not args.no_index and not args.dry_run:
        build_index()
        cleanup_orphaned_dirs(ALBUMS_DIR, STEMS_DIR)
        cleanup_empty_dirs(ALBUMS_DIR)
        cleanup_empty_dirs(STEMS_DIR)
    elif args.dry_run:
        print(f"\n[DRY RUN] Would scan and rebuild library.json")

if __name__ == "__main__":
    main()