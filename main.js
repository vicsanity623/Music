// ============================================================
//  SoundVault — main.js
//  Full-featured music player: library, playlists, stems, queue
// ============================================================

'use strict';

// ── Config ────────────────────────────────────────────────────
const IS_GITHUB_PAGES = window.location.hostname.includes('github.io');
const BASE_URL = IS_GITHUB_PAGES ? 'https://vics-imac-1.tail37b4f2.ts.net' : window.location.origin;
const LIBRARY_URL = `${BASE_URL}/library.json`;

// ── State ─────────────────────────────────────────────────────
const state = {
  library: null,   // { albums: [...] }
  rawLibrary: null, // unfiltered original copy from server
  queue: [],     // [{title, album, path, stems, format}]
  queueIndex: -1,
  shuffle: false,
  repeat: 'none', // 'none' | 'one' | 'all'
  isPlaying: false,
  currentTrack: null,
  playlists: [],     // [{id, name, tracks:[...]}]
  liked: new Set(),
  downloaded: new Set(), // paths cached for offline
  deletedSongs: new Set(), // local deleted song paths
  renamedSongs: {},       // local custom titles: path -> newTitle
  view: 'home',
  albumView: null,   // current album name in detail view
  artistView: null,  // current artist name in detail view
  playlistView: null,   // current playlist id
  librarySubView: null, // 'albums' | 'artists' | 'songs' | 'downloaded' | null
  ctxTrack: null,   // track targeted by context menu
  ctxPlaylistId: null,
  audioCtx: null,
  lastTriggeredPlaylist: null,
};

// ── Audio engine ──────────────────────────────────────────────
const audio = document.getElementById('audio-engine');

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);


// -- Marquee text scroll for fullscreen player ------------------
function updateMarquee() {
  const el = $('player-album');
  if (!el) return;
  const span = el.querySelector('span');
  if (!span) return;
  const isFullscreen = $('player-bar')?.classList.contains('fullscreen');
  if (!isFullscreen) {
    el.classList.remove('marquee');
    return;
  }
  const overflow = span.scrollWidth - el.clientWidth;
  if (overflow > 4) {
    el.style.setProperty('--scroll-dist', `-${overflow + 8}px`);
    el.classList.add('marquee');
  } else {
    el.classList.remove('marquee');
  }
}

// -- Init -------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  loadPersistedData();
  registerSW();
  setupGreeting();
  setupEventListeners();
  setupMediaSession();
  await loadLibrary();
  renderAll();
});


// ── Service Worker ────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
}

// ── Persistence (localStorage) ───────────────────────────────
function loadPersistedData() {
  try {
    const pl = localStorage.getItem('sv_playlists');
    if (pl) state.playlists = JSON.parse(pl);
    const liked = localStorage.getItem('sv_liked');
    if (liked) state.liked = new Set(JSON.parse(liked));
    const dl = localStorage.getItem('sv_downloaded');
    if (dl) state.downloaded = new Set(JSON.parse(dl));
    const deleted = localStorage.getItem('sv_deleted_songs');
    if (deleted) state.deletedSongs = new Set(JSON.parse(deleted));
    const renamed = localStorage.getItem('sv_renamed_songs');
    if (renamed) state.renamedSongs = JSON.parse(renamed);
  } catch (e) { console.warn('Persistence load error', e); }
}

function persist() {
  try {
    localStorage.setItem('sv_playlists', JSON.stringify(state.playlists));
    localStorage.setItem('sv_liked', JSON.stringify([...state.liked]));
    localStorage.setItem('sv_downloaded', JSON.stringify([...state.downloaded]));
    localStorage.setItem('sv_deleted_songs', JSON.stringify([...state.deletedSongs]));
    localStorage.setItem('sv_renamed_songs', JSON.stringify(state.renamedSongs));
  } catch (e) { }
}

// ── Load library ─────────────────────────────────────────────
async function loadLibrary() {
  const spinner = document.createElement('div');
  spinner.id = 'global-spinner';
  spinner.innerHTML = `<div class="loading-msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)"><div class="loading-spinner"></div><p>Loading library…</p></div>`;
  document.body.appendChild(spinner);

  try {
    const res = await fetch(LIBRARY_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.rawLibrary = await res.json();
    filterLocalLibrary();
    migrateStaleData();
  } catch (e) {
    console.error('Failed to load library.json', e);
    state.rawLibrary = { albums: [] };
    state.library = { albums: [] };
    showToast('Could not load library. Is the server running?', 'warn');
  } finally {
    spinner.remove();
  }
}

// ── Greeting ─────────────────────────────────────────────────
function setupGreeting() {
  const h = new Date().getHours();
  const el = $('greeting-time');
  if (!el) return;
  if (h < 12) el.textContent = 'AM';
  else if (h < 17) el.textContent = 'PM';
  else el.textContent = 'PM';
}

// ── Render everything ─────────────────────────────────────────
function renderAll() {
  renderHomeAlbums();
  renderLibraryRecent();
  renderLibraryAlbums();
  renderSidebarPlaylists();
  renderMobilePlaylists();
  switchView(state.view);
}

function renderHomeAlbums() {
  const grid = $('home-albums');
  if (!grid) return;
  grid.innerHTML = '';
  if (!state.library?.albums?.length) {
    grid.innerHTML = `<p class="loading-msg">No albums found. Run the download script first.</p>`;
    return;
  }
  state.library.albums.forEach((album, i) => {
    grid.appendChild(makeAlbumCard(album, i));
  });
}

// Recently added (reversed, first 8)
function renderLibraryRecent() {
  const grid = $('library-albums-recent');
  if (!grid) return;
  grid.innerHTML = '';
  if (!state.library?.albums?.length) return;
  const recent = [...state.library.albums].reverse().slice(0, 8);
  recent.forEach((album, i) => {
    grid.appendChild(makeAlbumCard(album, i));
  });
}

function renderLibraryAlbums() {
  const grid = $('library-albums');
  if (!grid) return;
  grid.innerHTML = '';
  if (!state.library?.albums?.length) {
    grid.innerHTML = `<p class="loading-msg">No albums found.</p>`;
    return;
  }
  let albums = [...state.library.albums];
  const sort = $('library-sort')?.value || 'newest';
  if (sort === 'a-z') {
    albums.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'z-a') {
    albums.sort((a, b) => b.name.localeCompare(a.name));
  } else {
    albums.reverse();
  }
  albums.forEach((album, i) => {
    grid.appendChild(makeAlbumCard(album, i));
  });
}

// ── Artists helpers ───────────────────────────────────────────
function getArtistsMap() {
  // Build a map: artistName -> { tracks: [...], artistArt: string }
  // Artist is derived from album name by stripping " - AlbumTitle" pattern,
  // or we use the full album name as artist if no separator found.
  const map = new Map();
  if (!state.library?.albums) return map;
  state.library.albums.forEach(album => {
    // Try to extract artist from "Artist - Album" format
    const sepIdx = album.name.indexOf(' - ');
    const artist = sepIdx > -1 ? album.name.substring(0, sepIdx) : album.name;
    if (!map.has(artist)) map.set(artist, { tracks: [], artistArt: null });

    if (album.artist_art && !map.get(artist).artistArt) {
      map.get(artist).artistArt = album.artist_art;
    }

    album.tracks.forEach(t => {
      map.get(artist).tracks.push({ ...t, albumName: album.name });
    });
  });
  return map;
}

function renderArtistsList(filterText = '') {
  const ul = $('artists-list');
  const scrollContainer = $('artists-az-scroll');
  if (!ul) return;
  ul.innerHTML = '';
  if (scrollContainer) scrollContainer.innerHTML = '';

  const map = getArtistsMap();
  let sorted = [...map.keys()].sort((a, b) => a.localeCompare(b));

  if (filterText) {
    const lower = filterText.toLowerCase();
    sorted = sorted.filter(a => a.toLowerCase().includes(lower));
  }

  if (!sorted.length) {
    ul.innerHTML = `<p class="loading-msg">No artists found.</p>`;
    return;
  }

  let currentLetter = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');

  // Set up A-Z scroll bar
  if (!filterText && scrollContainer) {
    alphabet.forEach(char => {
      const el = document.createElement('div');
      el.className = 'az-char';
      el.textContent = char;
      el.addEventListener('click', () => {
        const target = document.getElementById(`artist-sep-${char === '#' ? 'num' : char}`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      scrollContainer.appendChild(el);
    });
  }

  sorted.forEach(artist => {
    const data = map.get(artist);
    const tracks = data.tracks;

    // Check for letter separator
    const firstChar = artist.charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(firstChar) ? firstChar : '#';
    if (!filterText && letter !== currentLetter) {
      currentLetter = letter;
      const sep = document.createElement('div');
      sep.className = 'artist-separator';
      sep.id = `artist-sep-${currentLetter === '#' ? 'num' : currentLetter}`;
      sep.textContent = currentLetter;
      ul.appendChild(sep);
    }

    const li = document.createElement('li');
    li.className = 'artist-list-item';

    let artHtml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                     <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
                     <circle cx="12" cy="7" r="4"/>
                   </svg>`;
    let avatarStyle = '';
    if (data.artistArt) {
      artHtml = `<img src="${BASE_URL}/${data.artistArt}" alt="${escHtml(artist)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" loading="lazy" />`;
      avatarStyle = 'background:transparent;border:none;';
    }

    li.innerHTML = `
      <div class="artist-list-avatar" style="${avatarStyle}">
        ${artHtml}
      </div>
      <div class="artist-list-info">
        <span class="artist-list-name">${escHtml(artist)}</span>
        <span class="artist-list-count">${tracks.length} song${tracks.length !== 1 ? 's' : ''}</span>
      </div>
      <svg class="lib-cat-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    `;
    li.addEventListener('click', () => openArtistDetail(artist, tracks, data.artistArt));
    ul.appendChild(li);
  });
}

function openArtistDetail(artist, tracks, artistArt) {
  state.artistView = artist;
  $('artist-detail-name').textContent = artist;
  $('artist-detail-count').textContent = `${tracks.length} song${tracks.length !== 1 ? 's' : ''}`;

  const avatarIcon = $('artist-avatar-icon');
  if (avatarIcon) {
    if (artistArt) {
      avatarIcon.innerHTML = `<img src="${BASE_URL}/${artistArt}" alt="${escHtml(artist)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
      avatarIcon.style.background = 'transparent';
      avatarIcon.style.border = 'none';
    } else {
      avatarIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
      avatarIcon.style.background = 'var(--bg-active)';
      avatarIcon.style.border = '2px solid var(--border-hi)';
    }
  }

  renderTrackList('artist-track-list', tracks, null, null);
  showLibrarySubView('artist-detail');
}

// ── Songs sub-view ────────────────────────────────────────────
function renderAllSongs(filterText = '') {
  const ul = $('all-songs-list');
  if (!ul) return;
  ul.innerHTML = '';
  if (!state.library?.albums) return;
  const allTracks = [];
  state.library.albums.forEach(album => {
    album.tracks.forEach(t => allTracks.push({ ...t, albumName: album.name }));
  });
  allTracks.sort((a, b) => a.title.localeCompare(b.title));
  const q = filterText.toLowerCase().trim();
  const filtered = q ? allTracks.filter(t =>
    (t.title || '').toLowerCase().includes(q) ||
    (t.albumName || '').toLowerCase().includes(q)
  ) : allTracks;
  renderSongsIntoList(ul, filtered);
}

// ── Downloaded sub-view ───────────────────────────────────────
function renderDownloadedSongs(filterText = '') {
  const ul = $('downloaded-songs-list');
  if (!ul) return;
  ul.innerHTML = '';
  if (!state.library?.albums) return;
  const allTracks = [];
  state.library.albums.forEach(album => {
    album.tracks.forEach(t => {
      if (state.downloaded.has(t.path)) {
        allTracks.push({ ...t, albumName: album.name });
      }
    });
  });
  const actions = $('downloaded-actions');
  const q = filterText.toLowerCase().trim();
  const filtered = q ? allTracks.filter(t =>
    (t.title || '').toLowerCase().includes(q) ||
    (t.albumName || '').toLowerCase().includes(q)
  ) : allTracks;
  if (!filtered.length) {
    ul.innerHTML = q
      ? `<p class="loading-msg" style="padding:40px 20px;">No results for "${escHtml(filterText)}".</p>`
      : `<p class="loading-msg" style="padding:40px 20px;">No downloaded songs yet.<br><small style="opacity:.6">Songs are saved when you play them.</small></p>`;
    if (actions && !q) actions.classList.add('hidden');
    return;
  }
  if (actions) actions.classList.remove('hidden');
  renderSongsIntoList(ul, filtered);
}

function renderSongsIntoList(ul, tracks) {
  tracks.forEach((track, i) => {
    const li = document.createElement('li');
    const isActive = state.currentTrack && state.currentTrack.path === track.path;
    li.className = 'songs-list-item' + (isActive ? ' active' : '');
    li.dataset.path = track.path;
    const artUrl = getAlbumArt(track.albumName);
    const isDownloaded = state.downloaded.has(track.path);
    const addBtnColor = isDownloaded ? 'var(--red)' : 'var(--text-muted)';
    li.innerHTML = `
      <div class="swipe-bg">
        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        Delete from Device
      </div>
      <div class="swipe-content">
        <div class="song-thumb" style="position:relative;${artUrl ? 'background:#111118;' : 'background:var(--bg-active);'}">
          ${artUrl
        ? `<img class="song-thumb-art" src="${artUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px;" loading="lazy"/>`
        : `<svg class="song-thumb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:55%;height:55%;color:var(--text-muted)"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`
      }
          <div class="playing-indicator" style="position:absolute;inset:0;margin:auto;width:fit-content;height:fit-content;">
            <span></span><span></span><span></span>
          </div>
        </div>
        <div class="song-info">
          <p class="track-title">${escHtml(getTrackTitle(track))}</p>
          <p class="player-album">${escHtml(track.albumName || '')}</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="track-format">${track.format || 'MP3'}</span>
          <button class="track-add-btn" style="background:none;border:none;color:${addBtnColor};cursor:pointer;padding:4px;" title="Add to Playlist">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
      </div>
    `;
    li.addEventListener('click', () => {
      state.queue = tracks;
      state.queueIndex = i;
      playCurrentQueueItem();
    });
    li.querySelector('.track-add-btn').addEventListener('click', e => {
      e.stopPropagation();
      openAddToPlaylistModal([{ ...track }]);
    });
    li.addEventListener('contextmenu', e => {
      e.preventDefault();
      openContextMenu(e, track, null);
    });
    initSwipeToDelete(li, track);
    initLongPress(li, () => openRenameModal(track));
    ul.appendChild(li);
  });
}

// ── Library sub-view switcher ─────────────────────────────────
function showLibrarySubView(name) {
  // name: null | 'albums' | 'artists' | 'artist-detail' | 'songs' | 'downloaded' | 'album-detail'
  state.librarySubView = name;

  const views = [
    'library-root',
    'library-albums-view',
    'library-artists-view',
    'library-artist-detail',
    'library-songs-view',
    'library-downloaded-view',
    'album-detail',
  ];
  views.forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });

  if (!name) {
    $('library-root').classList.remove('hidden');
  } else if (name === 'album-detail') {
    $('album-detail').classList.remove('hidden');
  } else if (name === 'artist-detail') {
    $('library-artist-detail').classList.remove('hidden');
  } else {
    $(`library-${name}-view`)?.classList.remove('hidden');
  }
}

// ── Album art helper ──────────────────────────────────────────
function getAlbumArt(albumName) {
  const album = state.library?.albums?.find(a => a.name === albumName);
  return album?.art ? `${BASE_URL}/${album.art}` : null;
}

function artInnerHTML(artUrl, hue, size = '40%') {
  if (artUrl) {
    return `<img src="${artUrl}" alt="cover" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" loading="lazy" onerror="this.parentElement.dataset.broken='1';this.remove()" />`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="width:${size};height:${size}"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;
}

function makeAlbumCard(album, idx) {
  const card = document.createElement('div');
  card.className = 'album-card';
  const hue = idx % 5;
  const artUrl = album.art ? `${BASE_URL}/${album.art}` : null;
  card.innerHTML = `
    <div class="card-art" data-hue="${artUrl ? '' : hue}" style="${artUrl ? 'background:#111118;' : ''}">
      ${artInnerHTML(artUrl, hue)}
      <button class="card-play-btn" data-album="${album.name}" title="Play album">
        <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9z"/></svg>
      </button>
    </div>
    <p class="card-title">${escHtml(album.name)}</p>
    <p class="card-sub">${album.tracks.length} track${album.tracks.length !== 1 ? 's' : ''}</p>
  `;
  card.addEventListener('click', e => {
    if (e.target.closest('.card-play-btn')) playAlbum(album);
    else openAlbumDetail(album);
  });
  return card;
}

// ── Album detail ──────────────────────────────────────────────
function openAlbumDetail(album) {
  state.albumView = album.name;
  $('detail-title').textContent = album.name;
  const artUrl = album.art ? `${BASE_URL}/${album.art}` : null;
  $('detail-art').innerHTML = artInnerHTML(artUrl, 0, '50%');
  $('detail-art').style.background = artUrl ? '#111118' : '';
  renderTrackList('track-list', album.tracks, album.name, null);
  switchView('library');
  showLibrarySubView('album-detail');
}

function renderTrackList(listId, tracks, albumName, playlistId) {
  const ul = $(listId);
  ul.innerHTML = '';
  tracks.forEach((track, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;
    li.dataset.album = albumName || '';
    li.dataset.playlistId = playlistId || '';
    li.dataset.path = track.path;

    const isActive = state.currentTrack && state.currentTrack.path === track.path;
    li.className = isActive ? 'active' : '';
    const isDownloaded = state.downloaded.has(track.path);
    const addBtnColor = isDownloaded ? 'var(--red)' : 'var(--text-muted)';
    li.innerHTML = `
      <div class="swipe-bg">
        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        Delete from Device
      </div>
      <div class="swipe-content">
        <div class="track-num">
          <span class="track-num-wrap">${i + 1}</span>
          <div class="playing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
        <div class="track-info">
          <p class="track-title">${escHtml(getTrackTitle(track))}</p>
          ${albumName === null && track.albumName ? `<p class="player-album" style="font-size:0.78rem;color:var(--text-muted);">${escHtml(track.albumName)}</p>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="track-format">${track.format || 'MP3'}</span>
          <button class="track-add-btn" style="background:none;border:none;color:${addBtnColor};cursor:pointer;padding:4px;" title="Add to Playlist">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
      </div>
    `;
    li.addEventListener('click', () => playTrackFromContext(tracks, i, albumName || track.albumName));
    li.querySelector('.track-add-btn').addEventListener('click', e => {
      e.stopPropagation();
      openAddToPlaylistModal([{ ...track, albumName: albumName || track.albumName }]);
    });
    li.addEventListener('contextmenu', e => {
      e.preventDefault();
      openContextMenu(e, track, playlistId);
    });
    initSwipeToDelete(li, track);
    initLongPress(li, () => openRenameModal(track));
    ul.appendChild(li);
  });
}

function playTrackFromContext(tracks, index, albumName) {
  state.queue = tracks.map(t => ({ ...t, albumName: albumName || t.albumName }));
  state.queueIndex = index;
  playCurrentQueueItem();
}

// ── Play controls ─────────────────────────────────────────────
function playAlbum(album, shuffleIt = false) {
  state.queue = album.tracks.map(t => ({ ...t, albumName: album.name }));
  if (shuffleIt) {
    shuffleArray(state.queue);
    state.queueIndex = 0;
  } else {
    state.queueIndex = 0;
  }
  playCurrentQueueItem();
}

function playPlaylist(playlist, shuffleIt = false) {
  state.queue = [...playlist.tracks];
  if (shuffleIt) shuffleArray(state.queue);
  state.queueIndex = 0;
  playCurrentQueueItem();
}

function playCurrentQueueItem() {
  if (state.queueIndex < 0 || state.queueIndex >= state.queue.length) return;
  const track = state.queue[state.queueIndex];
  state.currentTrack = track;
  updateMediaSession(track);
  loadAndPlay(track);
  updatePlayerUI(track);
  updateTrackListHighlight();
  renderQueuePanel();
  downloadForOffline(track);
}

function loadAndPlay(track) {
  const url = `${BASE_URL}/${track.path}`;
  audio.src = url;
  audio.load();
  audio.play().catch(e => console.warn('Autoplay blocked:', e));
  state.isPlaying = true;
}

function updatePlayerUI(track) {
  $('player-bar').classList.remove('hidden');
  $('player-title').textContent = getTrackTitle(track) || '—';
  // Wrap album name in span for marquee animation
  const albumEl = $('player-album');
  albumEl.innerHTML = `<span>${escHtml(track.albumName || '—')}</span>`;
  albumEl.classList.remove('marquee');
  setTimeout(() => updateMarquee(), 80);

  $('icon-play').classList.add('hidden');
  $('icon-pause').classList.remove('hidden');

  // Show album art in player bar
  const artUrl = getAlbumArt(track.albumName);
  const playerArt = $('player-art');
  if (artUrl) {
    playerArt.innerHTML = `<img src="${artUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" />`;
  } else {
    playerArt.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;
  }

  $('btn-like').classList.toggle('liked', state.liked.has(track.path));
}

function updateTrackListHighlight() {
  // Clear old highlights for both track-list rows and songs-list items
  $$('.track-list li').forEach(li => li.classList.remove('active'));
  $$('.songs-list-item').forEach(li => li.classList.remove('active'));
  if (!state.currentTrack) return;
  const activePath = state.currentTrack.path;
  // Highlight track-list rows by matching data-path
  $$('.track-list li[data-path]').forEach(li => {
    if (li.dataset.path === activePath) li.classList.add('active');
  });
  // Fallback: match by queue index within same context (for rows without data-path)
  $$('.track-list li:not([data-path])').forEach(li => {
    const idx = parseInt(li.dataset.index);
    const album = li.dataset.album;
    const plId = li.dataset.playlistId;
    // Only highlight if the album/playlist context matches
    const track = state.queue[idx];
    if (track && track.path === activePath) {
      li.classList.add('active');
    }
  });
  // Highlight songs-list items by path
  $$('.songs-list-item[data-path]').forEach(li => {
    if (li.dataset.path === activePath) li.classList.add('active');
  });
}

// ── Playback events ───────────────────────────────────────────
audio.addEventListener('timeupdate', () => {
  if (!audio.duration || isScrubbing) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('progress-bar').style.width = pct + '%';
  $('progress-thumb').style.left = pct + '%';
  $('time-current').textContent = formatTime(audio.currentTime);
  $('time-total').textContent = formatTime(audio.duration);
});

audio.addEventListener('ended', () => {
  if (state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  if (state.shuffle) {
    state.queueIndex = Math.floor(Math.random() * state.queue.length);
  } else {
    state.queueIndex++;
  }
  if (state.queueIndex >= state.queue.length) {
    if (state.repeat === 'all') state.queueIndex = 0;
    else { state.isPlaying = false; setPlayPauseIcon(false); return; }
  }
  playCurrentQueueItem();
});

audio.addEventListener('play', () => { state.isPlaying = true; setPlayPauseIcon(true); });
audio.addEventListener('pause', () => { state.isPlaying = false; setPlayPauseIcon(false); });

function setPlayPauseIcon(playing) {
  $('icon-play').classList.toggle('hidden', playing);
  $('icon-pause').classList.toggle('hidden', !playing);
}

// ── Progress bar scrubbing ────────────────────────────────────
let isScrubbing = false;
let scrubPct = 0;
const progressTrack = $('progress-track');

function scrubMove(clientX) {
  const rect = progressTrack.getBoundingClientRect();
  scrubPct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const pctStr = (scrubPct * 100) + '%';
  $('progress-bar').style.width = pctStr;
  $('progress-thumb').style.left = pctStr;
  if (audio.duration) {
    $('time-current').textContent = formatTime(scrubPct * audio.duration);
  }
}

function scrubCommit() {
  if (!isScrubbing) return;
  isScrubbing = false;
  if (audio.duration) audio.currentTime = scrubPct * audio.duration;
}

progressTrack.addEventListener('mousedown', e => { isScrubbing = true; scrubMove(e.clientX); });
document.addEventListener('mousemove', e => { if (isScrubbing) scrubMove(e.clientX); });
document.addEventListener('mouseup', scrubCommit);
progressTrack.addEventListener('touchstart', e => {
  isScrubbing = true;
  scrubMove(e.touches[0].clientX);
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (isScrubbing) {
    e.preventDefault();
    scrubMove(e.touches[0].clientX);
  }
}, { passive: false });
document.addEventListener('touchend', scrubCommit);

// ── Keyboard shortcuts ────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowRight':
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); playNext(); }
      break;
    case 'ArrowLeft':
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); playPrev(); }
      break;
    case 'KeyM':
      audio.muted = !audio.muted;
      break;
  }
});

// ── Event listeners ───────────────────────────────────────────
function setupEventListeners() {
  // Nav buttons (sidebar + mobile)
  $$('.nav-btn, .mnav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Library category items
  $$('.library-category-item').forEach(item => {
    item.addEventListener('click', () => {
      const cat = item.dataset.category;
      switchView('library');
      if (cat === 'albums') {
        renderLibraryAlbums();
        showLibrarySubView('albums');
      } else if (cat === 'artists') {
        const input = $('artists-search-input');
        if (input) input.value = '';
        renderArtistsList();
        showLibrarySubView('artists');
      } else if (cat === 'songs') {
        const input = $('songs-search-input');
        if (input) input.value = '';
        renderAllSongs();
        showLibrarySubView('songs');
      } else if (cat === 'downloaded') {
        const input = $('downloaded-search-input');
        if (input) input.value = '';
        renderDownloadedSongs();
        showLibrarySubView('downloaded');
      } else if (cat === 'playlists') {
        switchView('playlists');
      }
    });
  });

  // Back buttons for library sub-views
  $('btn-back-to-library-root')?.addEventListener('click', () => showLibrarySubView(null));
  $('btn-back-to-library-from-artists')?.addEventListener('click', () => showLibrarySubView(null));
  $('btn-back-to-library-from-songs')?.addEventListener('click', () => showLibrarySubView(null));
  $('btn-back-to-library-from-downloaded')?.addEventListener('click', () => showLibrarySubView(null));
  $('btn-back-to-artists')?.addEventListener('click', () => {
    renderArtistsList();
    showLibrarySubView('artists');
  });

  // Artist play / shuffle
  $('btn-play-artist')?.addEventListener('click', () => {
    if (!state.artistView) return;
    const map = getArtistsMap();
    const data = map.get(state.artistView);
    if (data && data.tracks.length) {
      state.queue = [...data.tracks];
      state.queueIndex = 0;
      setShuffleMode(false);
      playCurrentQueueItem();
    }
  });
  $('btn-shuffle-artist')?.addEventListener('click', () => {
    if (!state.artistView) return;
    const map = getArtistsMap();
    const data = map.get(state.artistView);
    if (data && data.tracks.length) {
      state.queue = [...data.tracks];
      shuffleArray(state.queue);
      state.queueIndex = 0;
      setShuffleMode(true);
      playCurrentQueueItem();
    }
  });

  // All songs play / shuffle
  $('btn-play-all-songs')?.addEventListener('click', () => {
    if (!state.library?.albums) return;
    const allTracks = [];
    state.library.albums.forEach(album => {
      album.tracks.forEach(t => allTracks.push({ ...t, albumName: album.name }));
    });
    allTracks.sort((a, b) => a.title.localeCompare(b.title));
    state.queue = allTracks;
    state.queueIndex = 0;
    setShuffleMode(false);
    playCurrentQueueItem();
  });
  $('btn-shuffle-all-songs')?.addEventListener('click', () => {
    if (!state.library?.albums) return;
    const allTracks = [];
    state.library.albums.forEach(album => {
      album.tracks.forEach(t => allTracks.push({ ...t, albumName: album.name }));
    });
    shuffleArray(allTracks);
    state.queue = allTracks;
    state.queueIndex = 0;
    setShuffleMode(true);
    playCurrentQueueItem();
  });

  // Downloaded play / shuffle
  $('btn-play-downloaded')?.addEventListener('click', () => {
    if (!state.library?.albums) return;
    const allTracks = [];
    state.library.albums.forEach(album => {
      album.tracks.forEach(t => {
        if (state.downloaded.has(t.path)) {
          allTracks.push({ ...t, albumName: album.name });
        }
      });
    });
    if (!allTracks.length) return;
    state.queue = allTracks;
    state.queueIndex = 0;
    setShuffleMode(false);
    playCurrentQueueItem();
  });
  $('btn-shuffle-downloaded')?.addEventListener('click', () => {
    if (!state.library?.albums) return;
    const allTracks = [];
    state.library.albums.forEach(album => {
      album.tracks.forEach(t => {
        if (state.downloaded.has(t.path)) {
          allTracks.push({ ...t, albumName: album.name });
        }
      });
    });
    if (!allTracks.length) return;
    shuffleArray(allTracks);
    state.queue = allTracks;
    state.queueIndex = 0;
    setShuffleMode(true);
    playCurrentQueueItem();
  });

  // Play / Pause
  $('btn-play-pause').addEventListener('click', togglePlayPause);

  // Next / Prev
  $('btn-next').addEventListener('click', playNext);
  $('btn-prev').addEventListener('click', playPrev);

  // Shuffle
  $('btn-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('btn-shuffle').classList.toggle('active', state.shuffle);
  });

  // Repeat
  $('btn-repeat').addEventListener('click', cycleRepeat);

  // Volume
  $('volume-slider').addEventListener('input', e => {
    audio.volume = parseFloat(e.target.value);
  });

  // Like
  $('btn-like').addEventListener('click', () => {
    if (!state.currentTrack) return;
    const path = state.currentTrack.path;
    if (state.liked.has(path)) state.liked.delete(path);
    else state.liked.add(path);
    $('btn-like').classList.toggle('liked', state.liked.has(path));
    persist();
  });

  // Album detail play all / shuffle
  $('btn-play-album').addEventListener('click', () => {
    const album = state.library?.albums.find(a => a.name === state.albumView);
    if (album) {
      setShuffleMode(false);
      playAlbum(album);
    }
  });
  $('btn-shuffle-album').addEventListener('click', () => {
    const album = state.library?.albums.find(a => a.name === state.albumView);
    if (album) { setShuffleMode(true); playAlbum(album, true); }
  });
  $('btn-play-album').removeEventListener('click', null);
  $('btn-add-album-to-playlist').addEventListener('click', () => {
    const album = state.library?.albums.find(a => a.name === state.albumView);
    if (album) openAddToPlaylistModal(album.tracks.map(t => ({ ...t, albumName: album.name })));
  });

  // Back from album detail
  $('btn-back-library').addEventListener('click', () => {
    // Go back to wherever album was opened from
    if (state.librarySubView === 'album-detail') {
      showLibrarySubView(null);
    }
  });

  // Back from playlist detail
  $('btn-back-playlists').addEventListener('click', () => {
    switchView('playlists');
  });

  // New playlist
  $('btn-new-playlist').addEventListener('click', openNewPlaylistModal);
  $('btn-new-playlist-mobile').addEventListener('click', openNewPlaylistModal);

  // Playlist play / shuffle / delete
  $('btn-play-playlist').addEventListener('click', () => {
    const pl = state.playlists.find(p => p.id === state.playlistView);
    if (pl) { setShuffleMode(false); playPlaylist(pl); }
  });
  $('btn-shuffle-playlist').addEventListener('click', () => {
    const pl = state.playlists.find(p => p.id === state.playlistView);
    if (pl) { setShuffleMode(true); playPlaylist(pl, true); }
  });
  $('btn-delete-playlist').addEventListener('click', () => {
    if (!state.playlistView) return;
    if (confirm('Delete this playlist?')) {
      state.playlists = state.playlists.filter(p => p.id !== state.playlistView);
      persist();
      renderSidebarPlaylists();
      renderMobilePlaylists();
      switchView('playlists');
    }
  });

  // Playlist title editable
  $('pl-detail-title').addEventListener('blur', () => {
    const pl = state.playlists.find(p => p.id === state.playlistView);
    if (pl) {
      pl.name = $('pl-detail-title').textContent.trim() || pl.name;
      persist();
      renderSidebarPlaylists();
      renderMobilePlaylists();
    }
  });

  $('library-sort')?.addEventListener('change', renderLibraryAlbums);

  $('btn-add-playlist-player')?.addEventListener('click', () => {
    if (state.currentTrack) {
      openAddToPlaylistModal([{ ...state.currentTrack, albumName: state.currentTrack.albumName }]);
    }
  });

  $('player-art')?.addEventListener('click', () => {
    $('player-bar').classList.toggle('fullscreen');
    setTimeout(() => updateMarquee(), 250);
  });

  // Search inputs for Songs and Downloaded views
  $('songs-search-input')?.addEventListener('input', e => {
    renderAllSongs(e.target.value);
  });
  $('downloaded-search-input')?.addEventListener('input', e => {
    renderDownloadedSongs(e.target.value);
  });

  window.addEventListener('resize', updateMarquee);

  // Queue panel
  $('btn-queue').addEventListener('click', () => {
    $('queue-panel').classList.toggle('hidden');
    if (!$('queue-panel').classList.contains('hidden')) renderQueuePanel();
  });
  $('btn-close-queue').addEventListener('click', () => $('queue-panel').classList.add('hidden'));

  // Modal
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-overlay').addEventListener('click', e => {
    if (e.target === $('modal-overlay')) closeModal();
  });

  // Context menu
  $('ctx-play').addEventListener('click', () => {
    if (state.ctxTrack) {
      state.queue = [state.ctxTrack];
      state.queueIndex = 0;
      playCurrentQueueItem();
    }
    hideContextMenu();
  });
  $('ctx-next').addEventListener('click', () => {
    if (state.ctxTrack) {
      state.queue.splice(state.queueIndex + 1, 0, state.ctxTrack);
      renderQueuePanel();
    }
    hideContextMenu();
  });
  $('ctx-add-queue').addEventListener('click', () => {
    if (state.ctxTrack) state.queue.push(state.ctxTrack);
    renderQueuePanel();
    hideContextMenu();
    showToast('Added to queue');
  });
  $('ctx-add-playlist').addEventListener('click', () => {
    if (state.ctxTrack) openAddToPlaylistModal([state.ctxTrack]);
    hideContextMenu();
  });
  $('ctx-remove-playlist').addEventListener('click', () => {
    if (state.ctxTrack && state.ctxPlaylistId) {
      const pl = state.playlists.find(p => p.id === state.ctxPlaylistId);
      if (pl) {
        pl.tracks = pl.tracks.filter(t => t.path !== state.ctxTrack.path);
        persist();
        openPlaylistDetail(pl);
      }
    }
    hideContextMenu();
  });
  $('ctx-rename').addEventListener('click', () => {
    if (state.ctxTrack) openRenameModal(state.ctxTrack);
    hideContextMenu();
  });

  // Hide context menu on outside click
  document.addEventListener('click', e => {
    if (!$('context-menu').contains(e.target)) hideContextMenu();
  });

  // Search
  $('search-input').addEventListener('input', debounce(handleSearch, 150));

  // Artists Search
  $('artists-search-input')?.addEventListener('input', e => {
    renderArtistsList(e.target.value.trim());
  });
}

// ── View switching ────────────────────────────────────────────
function switchView(viewName) {
  state.view = viewName;
  $$('.view').forEach(v => v.classList.remove('active'));
  const target = $(`view-${viewName}`);
  if (target) target.classList.add('active');

  $$('.nav-btn, .mnav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // When switching to library, restore root unless sub-view is set
  if (viewName === 'library') {
    if (!state.librarySubView) {
      showLibrarySubView(null);
    }
  }
}

// ── Queue rendering ───────────────────────────────────────────
function renderQueuePanel() {
  const ul = $('queue-list');
  ul.innerHTML = '';
  state.queue.forEach((track, i) => {
    const li = document.createElement('li');
    li.className = i === state.queueIndex ? 'current' : '';
    li.innerHTML = `
      <span class="q-num">${i + 1}</span>
      <div>
        <div class="q-title">${escHtml(getTrackTitle(track))}</div>
        <div class="q-album">${escHtml(track.albumName || '')}</div>
      </div>
    `;
    li.addEventListener('click', () => {
      state.queueIndex = i;
      playCurrentQueueItem();
      renderQueuePanel();
    });
    ul.appendChild(li);
  });
}

// ── Playback helpers ──────────────────────────────────────────
function togglePlayPause() {
  if (!state.currentTrack) return;
  if (audio.paused) { audio.play(); }
  else { audio.pause(); }
}

function playNext() {
  if (!state.queue.length) return;
  if (state.shuffle) {
    state.queueIndex = Math.floor(Math.random() * state.queue.length);
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  }
  playCurrentQueueItem();
}

function playPrev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playCurrentQueueItem();
}

function cycleRepeat() {
  const modes = ['none', 'one', 'all'];
  const i = modes.indexOf(state.repeat);
  state.repeat = modes[(i + 1) % modes.length];
  const btn = $('btn-repeat');
  btn.classList.toggle('active', state.repeat !== 'none');
  btn.title = `Repeat: ${state.repeat}`;
}

// ── Context menu ──────────────────────────────────────────────
function openContextMenu(e, track, playlistId) {
  state.ctxTrack = track;
  state.ctxPlaylistId = playlistId || null;
  const menu = $('context-menu');
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 200);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  $('ctx-remove-playlist').classList.toggle('hidden', !playlistId);
}
function hideContextMenu() { $('context-menu').classList.add('hidden'); }

// ── Playlists ─────────────────────────────────────────────────
function renderSidebarPlaylists() {
  const ul = $('sidebar-playlists');
  ul.innerHTML = '';
  state.playlists.forEach(pl => {
    const li = document.createElement('li');
    li.textContent = pl.name;
    li.className = state.playlistView === pl.id ? 'active' : '';
    li.addEventListener('click', () => openPlaylistDetail(pl));
    ul.appendChild(li);
  });
}

function renderMobilePlaylists() {
  const ul = $('playlist-list-mobile');
  if (!ul) return;
  ul.innerHTML = '';
  state.playlists.forEach(pl => {
    const li = document.createElement('li');
    const iconHtml = buildPlaylistStackedArt(pl, 'width:100%;height:100%;');
    li.innerHTML = `
      <div class="pl-icon" style="overflow:hidden;border-radius:6px;">${iconHtml}</div>
      <div class="pl-info">
        <div class="pl-name">${escHtml(pl.name)}</div>
        <div class="pl-count">${pl.tracks.length} track${pl.tracks.length !== 1 ? 's' : ''}</div>
      </div>
    `;
    li.addEventListener('click', () => openPlaylistDetail(pl));
    ul.appendChild(li);
  });
}

// ── Playlist stacked album art helper ────────────────────────
function buildPlaylistStackedArt(pl, extraStyle = '') {
  // Collect unique album art URLs from the playlist's tracks (up to 3)
  const seen = new Set();
  const arts = [];
  for (const t of pl.tracks) {
    const url = getAlbumArt(t.albumName);
    if (url && !seen.has(url)) {
      seen.add(url);
      arts.push(url);
      if (arts.length >= 3) break;
    }
  }
  if (!arts.length) {
    // Fall back to the default hamburger SVG icon
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="${extraStyle}"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg>`;
  }
  const stackClass = arts.length === 1 ? '' : `stack-${arts.length}`;
  const covers = arts.map(url => `<img class="stacked-cover" src="${url}" alt="" />`).join('');
  return `<div class="playlist-stacked-art ${stackClass}" style="${extraStyle}">${covers}</div>`;
}

function openPlaylistDetail(pl) {
  state.playlistView = pl.id;
  $('pl-detail-title').textContent = pl.name;
  $('pl-detail-count').textContent = `${pl.tracks.length} track${pl.tracks.length !== 1 ? 's' : ''}`;
  renderTrackList('pl-track-list', pl.tracks, null, pl.id);
  renderSidebarPlaylists();
  renderMobilePlaylists();

  // Update the big playlist icon in the detail view
  const artEl = $('pl-detail-art');
  if (artEl) artEl.innerHTML = buildPlaylistStackedArt(pl);

  $$('.view').forEach(v => v.classList.remove('active'));
  $('view-playlist-detail').classList.add('active');
}

function openNewPlaylistModal() {
  openModal('New Playlist', `
    <input type="text" id="new-pl-name" placeholder="Playlist name…" maxlength="80" />
  `, [
    {
      label: 'Create', cls: 'btn-gold', action: () => {
        const name = $('new-pl-name').value.trim() || 'My Playlist';
        const pl = { id: `pl_${Date.now()}`, name, tracks: [] };
        state.playlists.push(pl);
        persist();
        renderSidebarPlaylists();
        renderMobilePlaylists();
        closeModal();
        openPlaylistDetail(pl);
      }
    }
  ]);
  setTimeout(() => $('new-pl-name')?.focus(), 100);
}

function openAddToPlaylistModal(tracks) {
  let bodyHtml = `
    <div id="pl-modal-list" style="max-height: 220px; overflow-y: auto; margin-bottom: 16px;">
      ${state.playlists.map(pl => {
    const inPl = tracks.every(t => pl.tracks.some(pt => pt.path === t.path));
    return `<div class="modal-pl-item${inPl ? ' in-playlist' : ''}" data-pl="${pl.id}">
          <span>${escHtml(pl.name)}</span>
          <span class="add-check">✓</span>
        </div>`;
  }).join('')}
      ${!state.playlists.length ? '<p style="color:var(--text-muted);font-size:.88rem;margin-bottom:12px;">No playlists yet.</p>' : ''}
    </div>
    <div style="border-top:1px solid var(--border);padding-top:16px;display:flex;flex-direction:column;gap:10px;">
      <p style="font-size:0.8rem;color:var(--text-muted);margin:0;">Create a new playlist and add this song:</p>
      <div style="display:flex;gap:8px;">
        <input type="text" id="quick-pl-name" placeholder="New playlist name…" style="flex:1;margin:0;padding:8px 12px;background:var(--bg-active);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:0.88rem;" />
        <button class="btn-gold" id="btn-quick-create-pl" style="padding:8px 16px;font-size:0.85rem;border-radius:var(--radius);white-space:nowrap;">Create & Add</button>
      </div>
    </div>
  `;

  openModal('Add to Playlist', bodyHtml, []);

  $$('#pl-modal-list .modal-pl-item').forEach(item => {
    item.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === item.dataset.pl);
      if (!pl) return;
      tracks.forEach(t => {
        if (!pl.tracks.some(pt => pt.path === t.path)) {
          pl.tracks.push(t);
          downloadForOffline(t);
        }
      });
      persist();
      item.classList.add('in-playlist');
      showToast(`Added to "${pl.name}"`);
      closeModal();
    });
  });

  const quickInput = $('quick-pl-name');
  const quickBtn = $('btn-quick-create-pl');

  const createAndAdd = () => {
    const name = quickInput.value.trim() || 'My Playlist';
    const plId = `pl_${Date.now()}`;
    const newPl = { id: plId, name, tracks: [] };
    tracks.forEach(t => {
      newPl.tracks.push(t);
      downloadForOffline(t);
    });
    state.playlists.push(newPl);
    persist();
    renderSidebarPlaylists();
    renderMobilePlaylists();
    showToast(`Created "${name}" and added track${tracks.length !== 1 ? 's' : ''}`);
    closeModal();
  };

  if (quickBtn && quickInput) {
    quickBtn.addEventListener('click', createAndAdd);
    quickInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); createAndAdd(); }
    });
  }
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(title, bodyHtml, buttons) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const actions = $('modal-overlay').querySelector('.modal-actions');
  $$('#modal .modal-actions .btn-gold, #modal .modal-actions .btn-action').forEach(b => b.remove());
  buttons.forEach(btn => {
    const el = document.createElement('button');
    el.className = btn.cls || 'btn-secondary';
    el.textContent = btn.label;
    el.addEventListener('click', btn.action);
    actions.prepend(el);
  });
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() { $('modal-overlay').classList.add('hidden'); }

// ── Search ────────────────────────────────────────────────────
function isYouTubePlaylistUrl(str) {
  let urlStr = str.trim();
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = 'https://' + urlStr;
  }
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be') || host.includes('youtube-nocookie.com')) {
      return parsed.searchParams.has('list');
    }
  } catch (e) { }
  return false;
}

function handleSearch() {
  const rawQ = $('search-input').value.trim();
  if (isYouTubePlaylistUrl(rawQ)) {
    if (state.lastTriggeredPlaylist !== rawQ) {
      state.lastTriggeredPlaylist = rawQ;
      fetch(`${BASE_URL}/api/download-playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawQ })
      }).catch(err => console.error('Failed to trigger playlist download:', err));
    }
  }
  if (isYouTubeSingleUrl(rawQ)) {
    if (state.lastTriggeredPlaylist !== rawQ) {
      state.lastTriggeredPlaylist = rawQ;
      fetch(`${BASE_URL}/api/download-single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawQ })
      }).catch(err => console.error('Failed to trigger single download:', err));
    }
  }

  const q = rawQ.toLowerCase();
  const results = $('search-results');
  results.innerHTML = '';
  if (!q || !state.library) return;

  const matchedTracks = [];
  const matchedAlbums = [];

  state.library.albums.forEach(album => {
    if (album.name.toLowerCase().includes(q)) matchedAlbums.push(album);
    album.tracks.forEach(t => {
      const displayTitle = getTrackTitle(t);
      if (displayTitle.toLowerCase().includes(q)) matchedTracks.push({ ...t, albumName: album.name });
    });
  });

  if (matchedAlbums.length) {
    const section = document.createElement('div');
    section.innerHTML = `<p class="search-section-title">Albums</p>`;
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    matchedAlbums.forEach((album, i) => grid.appendChild(makeAlbumCard(album, i)));
    section.appendChild(grid);
    results.appendChild(section);
  }

  if (matchedTracks.length) {
    const section = document.createElement('div');
    section.style.marginTop = '24px';
    section.innerHTML = `<p class="search-section-title">Tracks</p>`;
    const ul = document.createElement('ul');
    ul.className = 'track-list';
    matchedTracks.forEach((track, i) => {
      const li = document.createElement('li');
      const isActive = state.currentTrack && state.currentTrack.path === track.path;
      li.className = isActive ? 'active' : '';
      li.dataset.path = track.path;
      li.dataset.index = i;
      li.innerHTML = `
        <div class="swipe-bg">
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          Delete from Device
        </div>
        <div class="swipe-content">
          <div class="track-num">
            <span class="track-num-wrap">${i + 1}</span>
            <div class="playing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
          <div class="track-info">
            <p class="track-title">${escHtml(getTrackTitle(track))}</p>
            <p class="player-album">${escHtml(track.albumName)}</p>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="track-format">${track.format || 'MP3'}</span>
            <button class="track-add-btn" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;" title="Add to Playlist">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
      `;
      li.addEventListener('click', () => {
        state.queue = matchedTracks;
        state.queueIndex = i;
        playCurrentQueueItem();
      });
      li.querySelector('.track-add-btn').addEventListener('click', e => {
        e.stopPropagation();
        openAddToPlaylistModal([{ ...track, albumName: track.albumName }]);
      });
      li.addEventListener('contextmenu', e => {
        e.preventDefault();
        openContextMenu(e, track, null);
      });
      initSwipeToDelete(li, track);
      initLongPress(li, () => openRenameModal(track));
      ul.appendChild(li);
    });
    section.appendChild(ul);
    results.appendChild(section);
  }

  if (!matchedTracks.length && !matchedAlbums.length) {
    results.innerHTML = `<p class="loading-msg">No results for "${escHtml(q)}"</p>`;
  }
}

function isYouTubeSingleUrl(str) {
  let urlStr = str.trim();
  if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be') || host.includes('youtube-nocookie.com')) {
      // Has a video ID but NO playlist parameter
      return (parsed.searchParams.has('v') || host.includes('youtu.be')) && !parsed.searchParams.has('list');
    }
  } catch (e) { }
  return false;
}

// ── Media Session API (lockscreen controls) ───────────────────
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', togglePlayPause);
  navigator.mediaSession.setActionHandler('pause', togglePlayPause);
  navigator.mediaSession.setActionHandler('nexttrack', playNext);
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('seekto', e => {
    if (audio.duration) audio.currentTime = e.seekTime;
  });
  navigator.mediaSession.setActionHandler('seekbackward', null);
  navigator.mediaSession.setActionHandler('seekforward', null);
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;

  const artUrl = getAlbumArt(track.albumName);
  const artworkArray = artUrl ? [
    { src: artUrl, sizes: '512x512', type: 'image/jpeg' },
    { src: artUrl, sizes: '256x256', type: 'image/jpeg' }
  ] : [];

  navigator.mediaSession.metadata = new MediaMetadata({
    title: getTrackTitle(track),
    artist: track.albumName || 'SoundVault',
    album: track.albumName || '',
    artwork: artworkArray
  });

  navigator.mediaSession.setActionHandler('nexttrack', playNext);
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);

  try {
    navigator.mediaSession.setActionHandler('seekbackward', null);
    navigator.mediaSession.setActionHandler('seekforward', null);
  } catch (e) { }

  navigator.mediaSession.playbackState = 'playing';
}

// ── Toast notifications ───────────────────────────────────────
function showToast(msg, type = 'info') {
  let toast = document.querySelector('.sv-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'sv-toast';
    toast.style.cssText = `
      position:fixed;bottom:calc(var(--player-h)+20px);left:50%;transform:translateX(-50%);
      background:var(--bg-raised);border:1px solid var(--border-hi);
      color:var(--text-primary);padding:10px 20px;border-radius:var(--radius-pill);
      font-size:.85rem;z-index:1000;pointer-events:none;
      opacity:0;transition:opacity .2s ease;white-space:nowrap;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2400);
}

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Shuffle mode helper ───────────────────────────────────────
function setShuffleMode(enabled) {
  state.shuffle = enabled;
  $('btn-shuffle')?.classList.toggle('active', enabled);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Offline caching ──────────────────────────────────────────
async function downloadForOffline(track) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('soundvault-audio-v5.8');
    const urlsToCache = [`${BASE_URL}/${track.path}`];
    if (track.stems) {
      for (const stem in track.stems) {
        urlsToCache.push(`${BASE_URL}/${track.stems[stem]}`);
      }
    }
    for (const url of urlsToCache) {
      const cached = await cache.match(url);
      if (!cached) {
        console.log('Downloading for offline:', url);
        await cache.add(url);
      }
    }
    // Mark as downloaded in state
    if (!state.downloaded.has(track.path)) {
      state.downloaded.add(track.path);
      persist();
    }
  } catch (e) {
    console.warn('Failed to cache for offline:', e);
  }
}

// ── Helper functions for Swipe & Rename ──────────────────────
function getTrackTitle(track) {
  if (!track) return '';
  return state.renamedSongs[track.path] || track.title || '';
}

function filterLocalLibrary() {
  if (!state.rawLibrary) return;
  // Clone rawLibrary to library
  state.library = JSON.parse(JSON.stringify(state.rawLibrary));
  if (state.library && state.library.albums) {
    state.library.albums.forEach(album => {
      album.tracks = album.tracks.filter(t => !state.deletedSongs.has(t.path));
    });
    state.library.albums = state.library.albums.filter(album => album.tracks.length > 0);
  }
}

function migrateStaleData() {
  if (!state.library || !state.library.albums) return;

  // Build a fast lookup map of current library tracks by path
  const allLibraryTracksByPath = new Map();
  state.library.albums.forEach(album => {
    album.tracks.forEach(track => {
      allLibraryTracksByPath.set(track.path, { ...track, albumName: album.name });
    });
  });

  let changed = false;

  // Helper to find new path for a given old path
  const resolvePath = (oldPath) => {
    if (allLibraryTracksByPath.has(oldPath)) return oldPath;
    
    const parts = oldPath.split('/');
    if (parts.length < 2) return null;
    const oldFilename = parts[parts.length - 1];
    const oldAlbumFolder = parts[parts.length - 2];
    
    const normOldFilename = oldFilename.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normOldAlbum = oldAlbumFolder.toLowerCase().replace(/[^a-z0-9]/g, '');

    let bestMatch = null;
    let highestScore = 0;

    state.library.albums.forEach(album => {
      const normAlbum = album.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const albumMatch = normAlbum === normOldAlbum || normAlbum.includes(normOldAlbum) || normOldAlbum.includes(normAlbum);

      album.tracks.forEach(track => {
        let score = 0;
        if (albumMatch) score += 50;

        const trackFilename = track.path.split('/').pop();
        const normTrackFilename = trackFilename.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normTrackFilename === normOldFilename) {
          score += 40;
        } else if (normTrackFilename.includes(normOldFilename) || normOldFilename.includes(normTrackFilename)) {
          score += 20;
        }

        const normTrackTitle = (track.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normOldFilename.includes(normTrackTitle) || normTrackTitle.includes(normOldFilename)) {
          score += 15;
        }

        if (score > highestScore) {
          highestScore = score;
          bestMatch = track.path;
        }
      });
    });

    if (highestScore >= 35) return bestMatch;
    return null;
  };

  // 1. Migrate liked songs
  const newLiked = new Set();
  state.liked.forEach(oldPath => {
    const newPath = resolvePath(oldPath);
    if (newPath) {
      newLiked.add(newPath);
      if (newPath !== oldPath) changed = true;
    } else {
      newLiked.add(oldPath);
    }
  });
  state.liked = newLiked;

  // 2. Migrate downloaded songs
  const newDownloaded = new Set();
  state.downloaded.forEach(oldPath => {
    const newPath = resolvePath(oldPath);
    if (newPath) {
      newDownloaded.add(newPath);
      if (newPath !== oldPath) changed = true;
    } else {
      newDownloaded.add(oldPath);
    }
  });
  state.downloaded = newDownloaded;

  // 3. Migrate deleted songs
  const newDeleted = new Set();
  state.deletedSongs.forEach(oldPath => {
    const newPath = resolvePath(oldPath);
    if (newPath) {
      newDeleted.add(newPath);
      if (newPath !== oldPath) changed = true;
    } else {
      newDeleted.add(oldPath);
    }
  });
  state.deletedSongs = newDeleted;

  // 4. Migrate renamed songs
  const newRenamed = {};
  for (const oldPath in state.renamedSongs) {
    const newPath = resolvePath(oldPath);
    if (newPath) {
      newRenamed[newPath] = state.renamedSongs[oldPath];
      if (newPath !== oldPath) changed = true;
    } else {
      newRenamed[oldPath] = state.renamedSongs[oldPath];
    }
  }
  state.renamedSongs = newRenamed;

  // 5. Migrate playlists
  state.playlists.forEach(pl => {
    const updatedTracks = [];
    pl.tracks.forEach(oldTrack => {
      let match = allLibraryTracksByPath.get(oldTrack.path);
      if (!match) {
        // Search robustly
        const normOldTitle = (oldTrack.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const normOldAlbum = (oldTrack.albumName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const oldFilename = oldTrack.path.split('/').pop();
        const normOldFilename = oldFilename.toLowerCase().replace(/[^a-z0-9]/g, '');

        let bestMatch = null;
        let highestScore = 0;

        state.library.albums.forEach(album => {
          const normAlbum = album.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const albumMatch = normAlbum === normOldAlbum || normAlbum.includes(normOldAlbum) || normOldAlbum.includes(normAlbum);

          album.tracks.forEach(track => {
            let score = 0;
            if (albumMatch) score += 50;

            const normTrackTitle = (track.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normTrackTitle === normOldTitle && normOldTitle.length > 0) {
              score += 40;
            } else if (normTrackTitle.includes(normOldTitle) || normOldTitle.includes(normTrackTitle)) {
              score += 20;
            }

            const trackFilename = track.path.split('/').pop();
            const normTrackFilename = trackFilename.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normTrackFilename === normOldFilename) {
              score += 35;
            }

            if (score > highestScore) {
              highestScore = score;
              bestMatch = { ...track, albumName: album.name };
            }
          });
        });

        if (highestScore >= 35) {
          match = bestMatch;
        }
      }

      if (match) {
        updatedTracks.push(match);
        if (match.path !== oldTrack.path || match.title !== oldTrack.title) {
          changed = true;
        }
      } else {
        updatedTracks.push(oldTrack);
      }
    });
    pl.tracks = updatedTracks;
  });

  if (changed) {
    persist();
    console.log('Migrated stale library data after rename/indexing.');
  }
}

async function deleteFromCache(track) {
  if (!('caches' in window)) return;
  const urls = [`${BASE_URL}/${track.path}`];
  if (track.stems) {
    for (const stem in track.stems) {
      urls.push(`${BASE_URL}/${track.stems[stem]}`);
    }
  }
  for (const cacheName of ['soundvault-audio-v5.8', 'soundvault-audio-v1', 'soundvault-audio-v4.0']) {
    try {
      const cache = await caches.open(cacheName);
      for (const url of urls) {
        await cache.delete(url);
      }
    } catch (e) {
      console.warn(`Failed to delete from cache ${cacheName}:`, e);
    }
  }
}

async function deleteSongFromDevice(track) {
  // 1. Add to local set of deleted tracks
  state.deletedSongs.add(track.path);

  // 2. Remove from downloaded set if it's there
  state.downloaded.delete(track.path);

  // 3. Delete from Cache API
  await deleteFromCache(track);

  // 4. Save to localStorage
  persist();

  // 5. If currently playing this track, stop or play next
  if (state.currentTrack && state.currentTrack.path === track.path) {
    if (state.queue.length > 1) {
      playNext();
    } else {
      audio.pause();
      state.currentTrack = null;
      state.isPlaying = false;
      $('player-bar').classList.add('hidden');
    }
  }

  // 6. Remove from any local playlists
  state.playlists.forEach(pl => {
    pl.tracks = pl.tracks.filter(t => t.path !== track.path);
  });
  persist();

  // 7. Show toast
  showToast(`"${getTrackTitle(track)}" removed from device`);

  // 8. Apply filter & Re-render
  filterLocalLibrary();
  renderAll();

  // Refresh detail subviews
  if (state.librarySubView === 'albums' && state.albumView) {
    const album = state.library?.albums.find(a => a.name === state.albumView);
    if (album) openAlbumDetail(album);
  } else if (state.librarySubView === 'artist-detail' && state.artistView) {
    const map = getArtistsMap();
    const data = map.get(state.artistView);
    if (data) {
      openArtistDetail(state.artistView, data.tracks, data.artistArt);
    } else {
      showLibrarySubView('artists');
    }
  } else if (state.librarySubView === 'songs') {
    const q = $('songs-search-input')?.value || '';
    renderAllSongs(q);
  } else if (state.librarySubView === 'downloaded') {
    const q = $('downloaded-search-input')?.value || '';
    renderDownloadedSongs(q);
  } else if (state.view === 'playlists' && state.playlistView) {
    const pl = state.playlists.find(p => p.id === state.playlistView);
    if (pl) openPlaylistDetail(pl);
  }
}

function initSwipeToDelete(li, track) {
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let isSwiping = false;
  const content = li.querySelector('.swipe-content');
  const bg = li.querySelector('.swipe-bg');
  if (!content || !bg) return;

  li.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    content.style.transition = 'none';
    bg.style.transition = 'none';
    isSwiping = false;
  }, { passive: true });

  li.addEventListener('touchmove', e => {
    const diffX = e.touches[0].clientX - startX;
    const diffY = e.touches[0].clientY - startY;

    if (!isSwiping) {
      if (Math.abs(diffX) > Math.abs(diffY) && diffX > 8) {
        isSwiping = true;
      }
    }

    if (isSwiping) {
      if (diffX > 0) {
        if (e.cancelable) e.preventDefault();
        content.style.transform = `translateX(${diffX}px)`;
        bg.style.opacity = Math.min(1, diffX / 80);
        currentX = diffX;
      } else {
        content.style.transform = 'translateX(0px)';
        bg.style.opacity = '0';
        currentX = 0;
      }
    }
  }, { passive: false });

  li.addEventListener('touchend', () => {
    content.style.transition = 'transform 0.2s ease';
    bg.style.transition = 'opacity 0.2s ease';

    if (isSwiping && currentX > 120) {
      content.style.transform = `translateX(${li.offsetWidth}px)`;
      bg.style.opacity = '1';
      setTimeout(() => {
        deleteSongFromDevice(track);
      }, 200);
    } else {
      content.style.transform = 'translateX(0px)';
      bg.style.opacity = '0';
    }
    isSwiping = false;
    currentX = 0;
  });
}

function initLongPress(element, callback) {
  let pressTimer;

  const start = (e) => {
    if (e.type === 'click' && e.button !== 0) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      callback();
    }, 600);
  };

  const cancel = () => {
    clearTimeout(pressTimer);
  };

  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchend', cancel, { passive: true });
  element.addEventListener('touchmove', cancel, { passive: true });

  element.addEventListener('mousedown', start);
  element.addEventListener('mouseup', cancel);
  element.addEventListener('mouseleave', cancel);
}

function openRenameModal(track) {
  const currentTitle = getTrackTitle(track);
  openModal('Rename Song', `
    <input type="text" id="rename-song-input" value="${escHtml(currentTitle)}" placeholder="Song title…" maxlength="120" style="width:100%;margin-bottom:12px;background:var(--bg-active);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);padding:8px 12px;box-sizing:border-box;" />
  `, [
    {
      label: 'Rename', cls: 'btn-gold', action: () => {
        const newTitle = $('rename-song-input').value.trim();
        if (newTitle) {
          state.renamedSongs[track.path] = newTitle;
          persist();
          showToast('Song renamed');
          closeModal();

          // Apply changes to rendering
          renderAll();

          if (state.librarySubView === 'albums' && state.albumView) {
            const album = state.library?.albums.find(a => a.name === state.albumView);
            if (album) openAlbumDetail(album);
          } else if (state.librarySubView === 'artist-detail' && state.artistView) {
            const map = getArtistsMap();
            const data = map.get(state.artistView);
            if (data) openArtistDetail(state.artistView, data.tracks, data.artistArt);
          } else if (state.librarySubView === 'songs') {
            const q = $('songs-search-input')?.value || '';
            renderAllSongs(q);
          } else if (state.librarySubView === 'downloaded') {
            const q = $('downloaded-search-input')?.value || '';
            renderDownloadedSongs(q);
          } else if (state.view === 'playlists' && state.playlistView) {
            const pl = state.playlists.find(p => p.id === state.playlistView);
            if (pl) openPlaylistDetail(pl);
          }

          if (state.currentTrack && state.currentTrack.path === track.path) {
            updatePlayerUI(state.currentTrack);
            updateMediaSession(state.currentTrack);
          }
        }
      }
    }
  ]);
  setTimeout(() => {
    const input = $('rename-song-input');
    if (input) {
      input.focus();
      input.select();
    }
  }, 100);
}
