# 🎵 SoundVault — Local Music System

Complete setup for Intel iMac: YouTube → audio → stem splitting → private streaming web app (PWA).

-----

## Folder Structure (on your external SSD)

```
MusicLibrary/
├── Albums/
│   └── Album Name/
│       ├── 01 - Track Title.mp3
│       └── 02 - Track Title.mp3
├── STEMS/
│   └── Album NameSTEMS/
│       └── Track_Title/
│           ├── vocals.mp3
│           ├── drums.mp3
│           ├── bass.mp3
│           └── other.mp3
├── library.json          ← auto-generated index
└── web/                  ← put all HTML/CSS/JS files here
    ├── index.html
    ├── style.css
    ├── main.js
    ├── sw.js
    ├── manifest.json
    └── icons/            ← add PWA icons here
```

-----

## 1. Install Dependencies (Intel iMac / macOS)

```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install yt-dlp and ffmpeg
brew install yt-dlp ffmpeg

# Install Python demucs (htdemucs_ft model)
pip3 install demucs

# Optional: install into isolated environment
brew install pipx && pipx install demucs

# Install Tailscale (for HTTPS remote access)
# Download from https://tailscale.com/download/mac
# Or: brew install tailscale
```

-----

## 2. Configure Music Root (optional)

By default the library is saved to `~/MusicLibrary`.
To use your external SSD instead:

```bash
# Add to ~/.zshrc or ~/.bash_profile:
export MUSIC_ROOT="/Volumes/YourSSD/MusicLibrary"
```

Then reload: `source ~/.zshrc`

-----

## 3. Make scripts executable

```bash
chmod +x download_and_stem.sh serve.sh
```

-----

## 4. Download an Album

```bash
# Interactive menu
./download_and_stem.sh

# OR direct:
./download_and_stem.sh --album "https://youtube.com/playlist?list=..." "Album Name"

# Single video:
./download_and_stem.sh --single "https://youtu.be/..." "Album Name"
```

**What happens per track:**

1. yt-dlp downloads the audio (MP3 320kbps or FLAC)
1. htdemucs_ft splits it into 4 stems (vocals / drums / bass / other)
1. Stems are saved to STEMS/AlbumSTEMS/TrackName/
1. Script moves to next track
1. After all tracks: `library.json` is rebuilt automatically

### Audio format options

Edit `download_and_stem.sh` top section:

```bash
AUDIO_FORMAT="mp3"   # or "flac"
AUDIO_QUALITY="320"  # kbps (for mp3)
STEMS_FMT="mp3"      # stem output format
```

-----

## 5. Copy web files to MusicLibrary/web/

```bash
mkdir -p ~/MusicLibrary/web/icons
cp index.html style.css main.js sw.js manifest.json ~/MusicLibrary/web/
```

### Generate PWA icons

You need PNG icons in `web/icons/` at these sizes:
`72, 96, 128, 144, 152, 192, 384, 512`

Quick way using ImageMagick:

```bash
brew install imagemagick

# Create a simple icon (or use your own PNG):
for size in 72 96 128 144 152 192 384 512; do
  convert -size ${size}x${size} xc:#0a0a0f \
    -fill '#c8a96e' -draw "circle $((size/2)),$((size/2)) $((size/2)),$((size/4))" \
    ~/MusicLibrary/web/icons/icon-${size}.png
done
```

-----

## 6. Start the Server

```bash
# Local only (http://localhost:8080)
./serve.sh

# With Tailscale HTTPS (accessible from iPhone anywhere)
./serve.sh --funnel
```

The server:

- Serves all audio files with proper MIME types and Range support
- Enables CORS for cross-origin audio
- Links Albums/ and STEMS/ folders automatically

-----

## 7. Tailscale Setup (for iPhone PWA)

1. Install Tailscale on iMac: https://tailscale.com/download/mac
1. Install Tailscale on iPhone: App Store
1. Sign in to the same account on both
1. Run `./serve.sh --funnel`
1. Your URL: `https://your-machine-name.tailnet-name.ts.net`

On iPhone:

- Visit the URL in Safari
- Tap **Share → Add to Home Screen**
- Opens as a native app with no browser chrome ✓

-----

## 8. Web App Features

|Feature      |Details                                                   |
|-------------|----------------------------------------------------------|
|Library      |All albums auto-loaded from library.json                  |
|Playback     |Play, pause, next, prev, seek                             |
|Queue        |Full queue management, reorder by clicking                |
|Shuffle      |Randomises playback order                                 |
|Repeat       |None / Repeat One / Repeat All                            |
|Like         |Heart tracks (saved locally)                              |
|Playlists    |Create, rename, delete; add any track or album            |
|Search       |Instant search across all tracks and albums               |
|Stem Mixer   |Per-track vocal/drums/bass/other sliders + solo/mute      |
|PWA          |Install to home screen, offline shell, lockscreen controls|
|Media Session|Lockscreen controls on iOS / macOS                        |
|Keyboard     |Space=play, ⌘→=next, ⌘←=prev, M=mute                      |
|Context menu |Right-click any track for full options                    |

-----

## 9. Rebuild Index After Adding Albums

```bash
./download_and_stem.sh --index
# or
./serve.sh  # then in another terminal:
MUSIC_ROOT=~/MusicLibrary python3 -c "
import json,os
from pathlib import Path
# ... (the index builder runs automatically after each download)
"
```

The web app loads `library.json` fresh on each open (network-first caching).
Just run `--index` after manually adding files, then refresh the browser.

-----

## 10. htdemucs_ft Notes

- **Model**: `htdemucs_ft` — fine-tuned 4-stem hybrid model (highest quality)
- **Speed**: ~3–5× real-time on Intel CPU (a 4-min song ≈ 12–20 min to process)
- **GPU**: Not available on Intel iMac, but demucs works well on CPU
- **Output**: vocals, drums, bass, other — each as a separate MP3/FLAC file
- **First run**: demucs auto-downloads the model weights (~80 MB)

-----

## Troubleshooting

**yt-dlp fails**: `yt-dlp -U` to update. YouTube changes APIs frequently.

**demucs not found**: `python3 -m demucs --help` — if missing, `pip3 install -U demucs`

**Audio won’t play in browser**: Check the server is running (`./serve.sh`), and the URL in main.js matches.

**Tailscale funnel fails**: Make sure you’ve run `tailscale up` and your account has Funnel enabled (free plan supports it).

**PWA not installing on iOS**: Must be served over HTTPS (Tailscale Funnel). HTTP on localhost won’t allow PWA install on iOS.

**Stems out of sync**: The stem mixer syncs on seek/play/pause events. If stems drift, stop and re-open the stems panel.

-----

## Credits & Licences

- **yt-dlp**: Unlicenced (public domain fork of youtube-dl)
- **ffmpeg**: LGPL / GPL
- **demucs**: MIT License — Facebook Research
- **Tailscale**: Commercial / BSL (free tier available)

> ⚠️ Download only content you have the right to download.
> Stems are for personal/creative use only.