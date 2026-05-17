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
  library:       null,   // { albums: [...] }
  queue:         [],     // [{title, album, path, stems, format}]
  queueIndex:    -1,
  shuffle:       false,
  repeat:        'none', // 'none' | 'one' | 'all'
  isPlaying:     false,
  currentTrack:  null,
  playlists:     [],     // [{id, name, tracks:[...]}]
  liked:         new Set(),
  view:          'home',
  albumView:     null,   // current album name in detail view
  playlistView:  null,   // current playlist id
  ctxTrack:      null,   // track targeted by context menu
  ctxPlaylistId: null,
  stemAudios:    {},     // { vocals: AudioElement, ... }
  stemGains:     {},
  audioCtx:      null,
};

// ── Audio engine ──────────────────────────────────────────────
const audio = document.getElementById('audio-engine');

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Init ──────────────────────────────────────────────────────
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
    navigator.serviceWorker.register('/sw.js').catch(console.warn);
  }
}

// ── Persistence (localStorage) ───────────────────────────────
function loadPersistedData() {
  try {
    const pl = localStorage.getItem('sv_playlists');
    if (pl) state.playlists = JSON.parse(pl);
    const liked = localStorage.getItem('sv_liked');
    if (liked) state.liked = new Set(JSON.parse(liked));
  } catch (e) { console.warn('Persistence load error', e); }
}

function persist() {
  try {
    localStorage.setItem('sv_playlists', JSON.stringify(state.playlists));
    localStorage.setItem('sv_liked', JSON.stringify([...state.liked]));
  } catch (e) {}
}

// ── Load library ─────────────────────────────────────────────
async function loadLibrary() {
  const main = $('main-content');
  // Show spinner while loading
  const views = $$('.view.active');
  views.forEach(v => {
    v.innerHTML = `<div class="loading-msg"><div class="loading-spinner"></div><p>Loading library…</p></div>`;
  });

  try {
    const res = await fetch(LIBRARY_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.library = await res.json();
  } catch (e) {
    console.error('Failed to load library.json', e);
    state.library = { albums: [] };
    showToast('Could not load library. Is the server running?', 'warn');
  }
}

// ── Greeting ─────────────────────────────────────────────────
function setupGreeting() {
  const h = new Date().getHours();
  const el = $('greeting-time');
  if (!el) return;
  if (h < 12) el.textContent = 'morning';
  else if (h < 17) el.textContent = 'afternoon';
  else el.textContent = 'evening';
}

// ── Render everything ─────────────────────────────────────────
function renderAll() {
  renderHomeAlbums();
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

  // Recent albums (last 4)
  const recentGrid = $('recent-albums');
  if (recentGrid) {
    recentGrid.innerHTML = '';
    const recent = [...state.library.albums].reverse().slice(0, 4);
    recent.forEach((album, i) => recentGrid.appendChild(makeAlbumCard(album, i)));
  }
}

function renderLibraryAlbums() {
  const grid = $('library-albums');
  if (!grid) return;
  grid.innerHTML = '';
  if (!state.library?.albums?.length) {
    grid.innerHTML = `<p class="loading-msg">No albums found.</p>`;
    return;
  }
  state.library.albums.forEach((album, i) => {
    grid.appendChild(makeAlbumCard(album, i));
  });
}

function makeAlbumCard(album, idx) {
  const card = document.createElement('div');
  card.className = 'album-card';
  const hue = idx % 5;
  card.innerHTML = `
    <div class="card-art" data-hue="${hue}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
      <button class="card-play-btn" data-album="${album.name}" title="Play album">
        <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9z"/></svg>
      </button>
    </div>
    <p class="card-title">${escHtml(album.name)}</p>
    <p class="card-sub">${album.tracks.length} track${album.tracks.length !== 1 ? 's' : ''}</p>
  `;
  card.addEventListener('click', e => {
    if (e.target.closest('.card-play-btn')) {
      playAlbum(album);
    } else {
      openAlbumDetail(album);
    }
  });
  return card;
}

// ── Album detail ──────────────────────────────────────────────
function openAlbumDetail(album) {
  state.albumView = album.name;
  $('detail-title').textContent = album.name;
  $('detail-art').innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
  `;
  renderTrackList('track-list', album.tracks, album.name, null);
  $('library-root').classList.add('hidden');
  $('album-detail').classList.remove('hidden');
  switchView('library');
}

function renderTrackList(listId, tracks, albumName, playlistId) {
  const ul = $(listId);
  ul.innerHTML = '';
  tracks.forEach((track, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;
    li.dataset.album = albumName || '';
    li.dataset.playlistId = playlistId || '';

    const isActive = state.currentTrack && state.currentTrack.path === track.path;

    li.className = isActive ? 'active' : '';
    li.innerHTML = `
      <div class="track-num">
        <span class="track-num-wrap">${i + 1}</span>
        <div class="playing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
      <div class="track-info">
        <p class="track-title">${escHtml(track.title)}</p>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="track-format">${track.format || 'MP3'}</span>
      </div>
    `;
    li.addEventListener('click', () => playTrackFromContext(tracks, i, albumName));
    li.addEventListener('contextmenu', e => {
      e.preventDefault();
      openContextMenu(e, track, playlistId);
    });
    ul.appendChild(li);
  });
}

function playTrackFromContext(tracks, index, albumName) {
  state.queue = tracks.map(t => ({ ...t, albumName }));
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
  loadAndPlay(track);
  updatePlayerUI(track);
  updateTrackListHighlight();
  renderQueuePanel();
  updateMediaSession(track);
}

function loadAndPlay(track) {
  stopStemAudio();
  const url = `${BASE_URL}/${track.path}`;
  audio.src = url;
  audio.load();
  audio.play().catch(e => console.warn('Autoplay blocked:', e));
  state.isPlaying = true;
}

function updatePlayerUI(track) {
  $('player-bar').classList.remove('hidden');
  $('player-title').textContent = track.title || '—';
  $('player-album').textContent = track.albumName || '—';
  $('icon-play').classList.add('hidden');
  $('icon-pause').classList.remove('hidden');

  const likeBtn = $('btn-like');
  likeBtn.classList.toggle('liked', state.liked.has(track.path));

  // Show stems button if this track has stems
  const stemsBtn = $('btn-stems');
  const hasStems = track.stems && Object.keys(track.stems).length > 0;
  stemsBtn.style.display = hasStems ? '' : 'none';
}

function updateTrackListHighlight() {
  $$('.track-list li').forEach(li => li.classList.remove('active'));
  if (!state.currentTrack) return;
  $$('.track-list li').forEach(li => {
    const idx = parseInt(li.dataset.index);
    const album = li.dataset.album;
    const track = state.queue[state.queueIndex];
    if (track && state.queue[idx]?.path === track.path) {
      li.classList.add('active');
    }
  });
}

// ── Playback events ───────────────────────────────────────────
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
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

audio.addEventListener('play',  () => { state.isPlaying = true;  setPlayPauseIcon(true); });
audio.addEventListener('pause', () => { state.isPlaying = false; setPlayPauseIcon(false); });

function setPlayPauseIcon(playing) {
  $('icon-play').classList.toggle('hidden', playing);
  $('icon-pause').classList.toggle('hidden', !playing);
}

// ── Progress bar scrubbing ────────────────────────────────────
let isScrubbing = false;
const progressTrack = $('progress-track');

function scrubTo(e) {
  const rect = progressTrack.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (audio.duration) audio.currentTime = pct * audio.duration;
}

progressTrack.addEventListener('mousedown', e => { isScrubbing = true; scrubTo(e); });
document.addEventListener('mousemove',  e => { if (isScrubbing) scrubTo(e); });
document.addEventListener('mouseup',    ()  => { isScrubbing = false; });
progressTrack.addEventListener('touchstart', e => { isScrubbing = true; scrubTo(e.touches[0]); }, { passive: true });
document.addEventListener('touchmove', e => { if (isScrubbing) scrubTo(e.touches[0]); }, { passive: true });
document.addEventListener('touchend', () => { isScrubbing = false; });

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
    if (album) playAlbum(album);
  });
  $('btn-shuffle-album').addEventListener('click', () => {
    const album = state.library?.albums.find(a => a.name === state.albumView);
    if (album) playAlbum(album, true);
  });
  $('btn-add-album-to-playlist').addEventListener('click', () => {
    const album = state.library?.albums.find(a => a.name === state.albumView);
    if (album) openAddToPlaylistModal(album.tracks.map(t => ({...t, albumName: album.name})));
  });

  // Back from album detail
  $('btn-back-library').addEventListener('click', () => {
    $('album-detail').classList.add('hidden');
    $('library-root').classList.remove('hidden');
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
    if (pl) playPlaylist(pl);
  });
  $('btn-shuffle-playlist').addEventListener('click', () => {
    const pl = state.playlists.find(p => p.id === state.playlistView);
    if (pl) playPlaylist(pl, true);
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

  // Stems panel
  $('btn-stems').addEventListener('click', () => {
    if ($('stems-panel').classList.contains('hidden')) openStemsPanel();
    else $('stems-panel').classList.add('hidden');
  });
  $('btn-close-stems').addEventListener('click', () => {
    $('stems-panel').classList.add('hidden');
    stopStemAudio();
  });

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
      const q = state.queue.length ? state.queue : [state.ctxTrack];
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
  $('ctx-stems').addEventListener('click', () => {
    if (state.ctxTrack) openStemsPanelForTrack(state.ctxTrack);
    hideContextMenu();
  });

  // Hide context menu on outside click
  document.addEventListener('click', e => {
    if (!$('context-menu').contains(e.target)) hideContextMenu();
  });

  // Search
  $('search-input').addEventListener('input', debounce(handleSearch, 150));
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

  // Restore library sub-views
  if (viewName === 'library') {
    $('library-root').classList.remove('hidden');
    $('album-detail').classList.add('hidden');
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
        <div class="q-title">${escHtml(track.title)}</div>
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
  menu.style.top  = y + 'px';
  $('ctx-remove-playlist').classList.toggle('hidden', !playlistId);
  const hasStems = track.stems && Object.keys(track.stems).length > 0;
  $('ctx-stems').style.display = hasStems ? '' : 'none';
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
    li.innerHTML = `
      <div class="pl-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg></div>
      <div class="pl-info">
        <div class="pl-name">${escHtml(pl.name)}</div>
        <div class="pl-count">${pl.tracks.length} track${pl.tracks.length !== 1 ? 's' : ''}</div>
      </div>
    `;
    li.addEventListener('click', () => openPlaylistDetail(pl));
    ul.appendChild(li);
  });
}

function openPlaylistDetail(pl) {
  state.playlistView = pl.id;
  $('pl-detail-title').textContent = pl.name;
  $('pl-detail-count').textContent = `${pl.tracks.length} track${pl.tracks.length !== 1 ? 's' : ''}`;
  renderTrackList('pl-track-list', pl.tracks, null, pl.id);
  renderSidebarPlaylists();

  // On mobile switch to playlist detail
  $$('.view').forEach(v => v.classList.remove('active'));
  $('view-playlist-detail').classList.add('active');
}

function openNewPlaylistModal() {
  openModal('New Playlist', `
    <input type="text" id="new-pl-name" placeholder="Playlist name…" maxlength="80" />
  `, [
    { label: 'Create', cls: 'btn-gold', action: () => {
      const name = $('new-pl-name').value.trim() || 'My Playlist';
      const pl = { id: `pl_${Date.now()}`, name, tracks: [] };
      state.playlists.push(pl);
      persist();
      renderSidebarPlaylists();
      renderMobilePlaylists();
      closeModal();
      openPlaylistDetail(pl);
    }}
  ]);
  setTimeout(() => $('new-pl-name')?.focus(), 100);
}

function openAddToPlaylistModal(tracks) {
  openModal('Add to Playlist', `
    <div id="pl-modal-list">
      ${state.playlists.map(pl => {
        const inPl = tracks.every(t => pl.tracks.some(pt => pt.path === t.path));
        return `<div class="modal-pl-item${inPl ? ' in-playlist' : ''}" data-pl="${pl.id}">
          <span>${escHtml(pl.name)}</span>
          <span class="add-check">✓</span>
        </div>`;
      }).join('')}
      ${!state.playlists.length ? '<p style="color:var(--text-muted);font-size:.88rem">No playlists yet. Create one first.</p>' : ''}
    </div>
  `, []);

  $$('#pl-modal-list .modal-pl-item').forEach(item => {
    item.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === item.dataset.pl);
      if (!pl) return;
      tracks.forEach(t => {
        if (!pl.tracks.some(pt => pt.path === t.path)) pl.tracks.push(t);
      });
      persist();
      item.classList.add('in-playlist');
      showToast(`Added to "${pl.name}"`);
      closeModal();
    });
  });
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(title, bodyHtml, buttons) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const actions = $('modal-overlay').querySelector('.modal-actions');
  // Remove any extra buttons
  $$('#modal .btn-gold, #modal .btn-action').forEach(b => b.remove());
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

// ── Stems ─────────────────────────────────────────────────────
function openStemsPanel() {
  if (state.currentTrack) openStemsPanelForTrack(state.currentTrack);
}

function openStemsPanelForTrack(track) {
  const panel = $('stems-panel');
  $('stems-track-name').textContent = track.title;
  const container = $('stems-tracks');
  container.innerHTML = '';
  stopStemAudio();

  const stems = track.stems || {};
  const stemNames = ['vocals', 'drums', 'bass', 'other'];

  if (!Object.keys(stems).length) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:.85rem;padding:20px 0">No stems available for this track.</p>`;
    panel.classList.remove('hidden');
    return;
  }

  stemNames.forEach(stemName => {
    if (!stems[stemName]) return;
    const stemAudio = new Audio();
    stemAudio.src = `${BASE_URL}/${stems[stemName]}`;
    stemAudio.volume = 1;
    state.stemAudios[stemName] = stemAudio;
    state.stemGains[stemName] = 1;

    // Sync stem playback with main audio
    stemAudio.load();
    if (state.isPlaying) {
      stemAudio.currentTime = audio.currentTime;
      stemAudio.play().catch(() => {});
    }

    const row = document.createElement('div');
    row.className = 'stem-row';
    row.innerHTML = `
      <span class="stem-label ${stemName}">${stemName}</span>
      <button class="stem-solo" data-stem="${stemName}">S</button>
      <input type="range" class="stem-vol" min="0" max="1" step="0.01" value="1" data-stem="${stemName}" />
      <button class="stem-mute" data-stem="${stemName}" title="Mute">🔊</button>
    `;

    row.querySelector('.stem-vol').addEventListener('input', e => {
      const vol = parseFloat(e.target.value);
      state.stemGains[stemName] = vol;
      stemAudio.volume = vol;
    });

    row.querySelector('.stem-mute').addEventListener('click', e => {
      stemAudio.muted = !stemAudio.muted;
      e.target.textContent = stemAudio.muted ? '🔇' : '🔊';
      e.target.classList.toggle('muted', stemAudio.muted);
    });

    row.querySelector('.stem-solo').addEventListener('click', e => {
      const btn = e.target;
      const isSolo = btn.classList.toggle('active');
      stemNames.forEach(sn => {
        if (state.stemAudios[sn]) {
          state.stemAudios[sn].muted = isSolo && sn !== stemName;
        }
      });
    });

    container.appendChild(row);
  });

  // Sync stem playback to main audio events
  audio.addEventListener('seeked', syncStems);
  audio.addEventListener('play',   resumeStems);
  audio.addEventListener('pause',  pauseStems);

  panel.classList.remove('hidden');
}

function syncStems() {
  Object.values(state.stemAudios).forEach(a => { a.currentTime = audio.currentTime; });
}
function resumeStems() {
  syncStems();
  Object.values(state.stemAudios).forEach(a => a.play().catch(() => {}));
}
function pauseStems() {
  Object.values(state.stemAudios).forEach(a => a.pause());
}
function stopStemAudio() {
  Object.values(state.stemAudios).forEach(a => { a.pause(); a.src = ''; });
  state.stemAudios = {};
  audio.removeEventListener('seeked', syncStems);
  audio.removeEventListener('play',   resumeStems);
  audio.removeEventListener('pause',  pauseStems);
}

// ── Search ────────────────────────────────────────────────────
function handleSearch() {
  const q = $('search-input').value.trim().toLowerCase();
  const results = $('search-results');
  results.innerHTML = '';
  if (!q || !state.library) return;

  const matchedTracks = [];
  const matchedAlbums = [];

  state.library.albums.forEach(album => {
    if (album.name.toLowerCase().includes(q)) matchedAlbums.push(album);
    album.tracks.forEach(t => {
      if (t.title.toLowerCase().includes(q)) matchedTracks.push({ ...t, albumName: album.name });
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
      li.innerHTML = `
        <span class="track-num">${i + 1}</span>
        <div class="track-info">
          <p class="track-title">${escHtml(track.title)}</p>
          <p class="player-album">${escHtml(track.albumName)}</p>
        </div>
        <span class="track-format">${track.format || 'MP3'}</span>
      `;
      li.addEventListener('click', () => {
        state.queue = matchedTracks;
        state.queueIndex = i;
        playCurrentQueueItem();
      });
      li.addEventListener('contextmenu', e => {
        e.preventDefault();
        openContextMenu(e, track, null);
      });
      ul.appendChild(li);
    });
    section.appendChild(ul);
    results.appendChild(section);
  }

  if (!matchedTracks.length && !matchedAlbums.length) {
    results.innerHTML = `<p class="loading-msg">No results for "${escHtml(q)}"</p>`;
  }
}

// ── Media Session API (lockscreen controls) ───────────────────
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play',           togglePlayPause);
  navigator.mediaSession.setActionHandler('pause',          togglePlayPause);
  navigator.mediaSession.setActionHandler('nexttrack',      playNext);
  navigator.mediaSession.setActionHandler('previoustrack',  playPrev);
  navigator.mediaSession.setActionHandler('seekto', e => {
    if (audio.duration) audio.currentTime = e.seekTime;
  });
}
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title:  track.title,
    artist: track.albumName || 'SoundVault',
    album:  track.albumName || '',
  });
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
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
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
