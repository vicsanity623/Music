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
  library:       null,
  queue:         [],
  queueIndex:    -1,
  shuffle:       false,
  repeat:        'none',
  isPlaying:     false,
  currentTrack:  null,
  playlists:     [],
  liked:         new Set(),
  view:          'home',
  albumView:     null,
  playlistView:  null,
  ctxTrack:      null,
  ctxPlaylistId: null,
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
  setupVisualizer();   // ← initialise visualizer (no new window)
  await loadLibrary();
  renderAll();
});

// ── Service Worker ────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
}

// ── Persistence ───────────────────────────────────────────────
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
  const spinner = document.createElement('div');
  spinner.id = 'global-spinner';
  spinner.innerHTML = `<div class="loading-msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)"><div class="loading-spinner"></div><p>Loading library…</p></div>`;
  document.body.appendChild(spinner);

  try {
    const res = await fetch(LIBRARY_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.library = await res.json();
  } catch (e) {
    console.error('Failed to load library.json', e);
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
  el.textContent = h < 12 ? 'AM' : 'PM';
}

// ── Render ────────────────────────────────────────────────────
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
  state.library.albums.forEach((album, i) => grid.appendChild(makeAlbumCard(album, i)));
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
  if (sort === 'a-z') albums.sort((a,b) => a.name.localeCompare(b.name));
  else if (sort === 'z-a') albums.sort((a,b) => b.name.localeCompare(a.name));
  else albums.reverse();
  albums.forEach((album, i) => grid.appendChild(makeAlbumCard(album, i)));
}

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
  const hue    = idx % 5;
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

function openAlbumDetail(album) {
  state.albumView = album.name;
  $('detail-title').textContent = album.name;
  const artUrl = album.art ? `${BASE_URL}/${album.art}` : null;
  $('detail-art').innerHTML = artInnerHTML(artUrl, 0, '50%');
  $('detail-art').style.background = artUrl ? '#111118' : '';
  renderTrackList('track-list', album.tracks, album.name, null);
  switchView('library');
  $('library-root').classList.add('hidden');
  $('album-detail').classList.remove('hidden');
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
        <div class="playing-indicator"><span></span><span></span><span></span></div>
      </div>
      <div class="track-info">
        <p class="track-title">${escHtml(track.title)}</p>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="track-format">${track.format || 'MP3'}</span>
        <button class="track-add-btn" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;" title="Add to Playlist">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
    `;
    li.addEventListener('click', () => playTrackFromContext(tracks, i, albumName));
    li.querySelector('.track-add-btn').addEventListener('click', e => {
      e.stopPropagation();
      openAddToPlaylistModal([{...track, albumName}]);
    });
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
  if (shuffleIt) { shuffleArray(state.queue); state.queueIndex = 0; }
  else state.queueIndex = 0;
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
  vizUpdateTrackInfo(track);   // keep visualizer pill in sync
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
  $('player-title').textContent = track.title || '—';
  $('player-album').textContent = track.albumName || '—';
  $('icon-play').classList.add('hidden');
  $('icon-pause').classList.remove('hidden');

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
  $$('.track-list li').forEach(li => li.classList.remove('active'));
  if (!state.currentTrack) return;
  $$('.track-list li').forEach(li => {
    const idx = parseInt(li.dataset.index);
    const track = state.queue[state.queueIndex];
    if (track && state.queue[idx]?.path === track.path) li.classList.add('active');
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
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (state.shuffle) state.queueIndex = Math.floor(Math.random() * state.queue.length);
  else state.queueIndex++;
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

// ── Progress scrubbing ────────────────────────────────────────
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
    case 'Space':       e.preventDefault(); togglePlayPause(); break;
    case 'ArrowRight':  if (e.metaKey || e.ctrlKey) { e.preventDefault(); playNext(); } break;
    case 'ArrowLeft':   if (e.metaKey || e.ctrlKey) { e.preventDefault(); playPrev(); } break;
    case 'KeyM':        audio.muted = !audio.muted; break;
    case 'Escape':      vizClose(); break;
  }
});

// ── Event listeners ───────────────────────────────────────────
function setupEventListeners() {
  $$('.nav-btn, .mnav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('btn-play-pause').addEventListener('click', togglePlayPause);
  $('btn-next').addEventListener('click', playNext);
  $('btn-prev').addEventListener('click', playPrev);

  $('btn-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('btn-shuffle').classList.toggle('active', state.shuffle);
  });

  $('btn-repeat').addEventListener('click', cycleRepeat);

  $('volume-slider').addEventListener('input', e => {
    audio.volume = parseFloat(e.target.value);
  });

  $('btn-like').addEventListener('click', () => {
    if (!state.currentTrack) return;
    const path = state.currentTrack.path;
    if (state.liked.has(path)) state.liked.delete(path);
    else state.liked.add(path);
    $('btn-like').classList.toggle('liked', state.liked.has(path));
    persist();
  });

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

  $('btn-back-library').addEventListener('click', () => {
    $('album-detail').classList.add('hidden');
    $('library-root').classList.remove('hidden');
  });

  $('btn-back-playlists').addEventListener('click', () => switchView('playlists'));

  $('btn-new-playlist').addEventListener('click', openNewPlaylistModal);
  $('btn-new-playlist-mobile').addEventListener('click', openNewPlaylistModal);

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
    if (state.currentTrack)
      openAddToPlaylistModal([{...state.currentTrack, albumName: state.currentTrack.albumName}]);
  });

  $('player-art')?.addEventListener('click', () => {
    $('player-bar').classList.toggle('fullscreen');
  });

  $('btn-queue').addEventListener('click', () => {
    $('queue-panel').classList.toggle('hidden');
    if (!$('queue-panel').classList.contains('hidden')) renderQueuePanel();
  });
  $('btn-close-queue').addEventListener('click', () => $('queue-panel').classList.add('hidden'));

  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-overlay').addEventListener('click', e => {
    if (e.target === $('modal-overlay')) closeModal();
  });

  $('ctx-play').addEventListener('click', () => {
    if (state.ctxTrack) { state.queue = [state.ctxTrack]; state.queueIndex = 0; playCurrentQueueItem(); }
    hideContextMenu();
  });
  $('ctx-next').addEventListener('click', () => {
    if (state.ctxTrack) { state.queue.splice(state.queueIndex + 1, 0, state.ctxTrack); renderQueuePanel(); }
    hideContextMenu();
  });
  $('ctx-add-queue').addEventListener('click', () => {
    if (state.ctxTrack) state.queue.push(state.ctxTrack);
    renderQueuePanel(); hideContextMenu(); showToast('Added to queue');
  });
  $('ctx-add-playlist').addEventListener('click', () => {
    if (state.ctxTrack) openAddToPlaylistModal([state.ctxTrack]);
    hideContextMenu();
  });
  $('ctx-remove-playlist').addEventListener('click', () => {
    if (state.ctxTrack && state.ctxPlaylistId) {
      const pl = state.playlists.find(p => p.id === state.ctxPlaylistId);
      if (pl) { pl.tracks = pl.tracks.filter(t => t.path !== state.ctxTrack.path); persist(); openPlaylistDetail(pl); }
    }
    hideContextMenu();
  });

  document.addEventListener('click', e => {
    if (!$('context-menu').contains(e.target)) hideContextMenu();
  });

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
  if (viewName === 'library') {
    $('library-root').classList.remove('hidden');
    $('album-detail').classList.add('hidden');
  }
}

// ── Queue ─────────────────────────────────────────────────────
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
    li.addEventListener('click', () => { state.queueIndex = i; playCurrentQueueItem(); renderQueuePanel(); });
    ul.appendChild(li);
  });
}

// ── Playback helpers ──────────────────────────────────────────
function togglePlayPause() {
  if (!state.currentTrack) return;
  if (audio.paused) audio.play(); else audio.pause();
}

function playNext() {
  if (!state.queue.length) return;
  if (state.shuffle) state.queueIndex = Math.floor(Math.random() * state.queue.length);
  else state.queueIndex = (state.queueIndex + 1) % state.queue.length;
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
  state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
  $('btn-repeat').classList.toggle('active', state.repeat !== 'none');
  $('btn-repeat').title = `Repeat: ${state.repeat}`;
}

// ── Context menu ──────────────────────────────────────────────
function openContextMenu(e, track, playlistId) {
  state.ctxTrack = track;
  state.ctxPlaylistId = playlistId || null;
  const menu = $('context-menu');
  menu.classList.remove('hidden');
  menu.style.left = Math.min(e.clientX, innerWidth - 200) + 'px';
  menu.style.top  = Math.min(e.clientY, innerHeight - 200) + 'px';
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
  $$('.view').forEach(v => v.classList.remove('active'));
  $('view-playlist-detail').classList.add('active');
}

function openNewPlaylistModal() {
  openModal('New Playlist', `<input type="text" id="new-pl-name" placeholder="Playlist name…" maxlength="80" />`, [
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
  let bodyHtml = `
    <div id="pl-modal-list" style="max-height:220px;overflow-y:auto;margin-bottom:16px;">
      ${state.playlists.map(pl => {
        const inPl = tracks.every(t => pl.tracks.some(pt => pt.path === t.path));
        return `<div class="modal-pl-item${inPl ? ' in-playlist' : ''}" data-pl="${pl.id}">
          <span>${escHtml(pl.name)}</span><span class="add-check">✓</span>
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
      tracks.forEach(t => { if (!pl.tracks.some(pt => pt.path === t.path)) { pl.tracks.push(t); downloadForOffline(t); } });
      persist(); item.classList.add('in-playlist');
      showToast(`Added to "${pl.name}"`); closeModal();
    });
  });

  const quickInput = $('quick-pl-name');
  const quickBtn   = $('btn-quick-create-pl');
  const createAndAdd = () => {
    const name = quickInput.value.trim() || 'My Playlist';
    const newPl = { id: `pl_${Date.now()}`, name, tracks: [] };
    tracks.forEach(t => { newPl.tracks.push(t); downloadForOffline(t); });
    state.playlists.push(newPl); persist();
    renderSidebarPlaylists(); renderMobilePlaylists();
    showToast(`Created "${name}" and added track${tracks.length !== 1 ? 's' : ''}`);
    closeModal();
  };
  if (quickBtn && quickInput) {
    quickBtn.addEventListener('click', createAndAdd);
    quickInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createAndAdd(); } });
  }
}

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
function handleSearch() {
  const q = $('search-input').value.trim().toLowerCase();
  const results = $('search-results');
  results.innerHTML = '';
  if (!q || !state.library) return;

  const matchedTracks = [], matchedAlbums = [];
  state.library.albums.forEach(album => {
    if (album.name.toLowerCase().includes(q)) matchedAlbums.push(album);
    album.tracks.forEach(t => {
      if (t.title.toLowerCase().includes(q)) matchedTracks.push({ ...t, albumName: album.name });
    });
  });

  if (matchedAlbums.length) {
    const section = document.createElement('div');
    section.innerHTML = `<p class="search-section-title">Albums</p>`;
    const grid = document.createElement('div'); grid.className = 'card-grid';
    matchedAlbums.forEach((album, i) => grid.appendChild(makeAlbumCard(album, i)));
    section.appendChild(grid); results.appendChild(section);
  }

  if (matchedTracks.length) {
    const section = document.createElement('div');
    section.style.marginTop = '24px';
    section.innerHTML = `<p class="search-section-title">Tracks</p>`;
    const ul = document.createElement('ul'); ul.className = 'track-list';
    matchedTracks.forEach((track, i) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="track-num">${i + 1}</span>
        <div class="track-info">
          <p class="track-title">${escHtml(track.title)}</p>
          <p class="player-album">${escHtml(track.albumName)}</p>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="track-format">${track.format || 'MP3'}</span>
          <button class="track-add-btn" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;" title="Add to Playlist">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
      `;
      li.addEventListener('click', () => { state.queue = matchedTracks; state.queueIndex = i; playCurrentQueueItem(); });
      li.querySelector('.track-add-btn').addEventListener('click', e => {
        e.stopPropagation(); openAddToPlaylistModal([{...track, albumName: track.albumName}]);
      });
      li.addEventListener('contextmenu', e => { e.preventDefault(); openContextMenu(e, track, null); });
      ul.appendChild(li);
    });
    section.appendChild(ul); results.appendChild(section);
  }

  if (!matchedTracks.length && !matchedAlbums.length)
    results.innerHTML = `<p class="loading-msg">No results for "${escHtml(q)}"</p>`;
}

// ── Media Session ─────────────────────────────────────────────
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play',          togglePlayPause);
  navigator.mediaSession.setActionHandler('pause',         togglePlayPause);
  navigator.mediaSession.setActionHandler('nexttrack',     playNext);
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('seekto', e => {
    if (audio.duration) audio.currentTime = e.seekTime;
  });
}
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title, artist: track.albumName || 'SoundVault', album: track.albumName || '',
  });
  navigator.mediaSession.playbackState = 'playing';
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg) {
  let toast = document.querySelector('.sv-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'sv-toast';
    toast.style.cssText = `position:fixed;bottom:calc(var(--player-h)+20px);left:50%;transform:translateX(-50%);background:var(--bg-raised);border:1px solid var(--border-hi);color:var(--text-primary);padding:10px 20px;border-radius:var(--radius-pill);font-size:.85rem;z-index:1000;pointer-events:none;opacity:0;transition:opacity .2s ease;white-space:nowrap;`;
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
  return `${Math.floor(sec/60)}:${Math.floor(sec%60).toString().padStart(2,'0')}`;
}
function shuffleArray(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];
  }
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a),ms); }; }

async function downloadForOffline(track) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('soundvault-audio-v1');
    const urls = [`${BASE_URL}/${track.path}`];
    if (track.stems) for (const s in track.stems) urls.push(`${BASE_URL}/${track.stems[s]}`);
    for (const url of urls) { if (!await cache.match(url)) await cache.add(url); }
  } catch(e) { console.warn('Offline cache failed:', e); }
}

// ════════════════════════════════════════════════════════════════
//  VISUALIZER — inline overlay, zero new windows, zero extra audio
//
//  The overlay (#viz-overlay) sits on top of everything.
//  It reads from the SAME <audio id="audio-engine"> element.
//  One AudioContext is created on first open and reused forever.
// ════════════════════════════════════════════════════════════════
function setupVisualizer() {
  const overlay   = $('viz-overlay');
  const glCanvas  = $('viz-gl');
  const fqCanvas  = $('viz-freq');
  const backBtn   = $('viz-back');
  const vizBtn    = $('btn-visualizer');
  const npTitle   = $('viz-title');
  const npAlbum   = $('viz-album');
  const npPill    = $('viz-nowplaying');

  if (!overlay || !glCanvas) return;

  // ── WebGL ──────────────────────────────────────────────────
  const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
  if (!gl) {
    vizBtn && (vizBtn.style.display = 'none');
    return;
  }

  function mkShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src.trim());
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, mkShader(gl.VERTEX_SHADER,   $('viz-vs').textContent));
  gl.attachShader(prog, mkShader(gl.FRAGMENT_SHADER, $('viz-fs').textContent));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const vbuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uRes  = gl.getUniformLocation(prog, 'u_res');
  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uBass = gl.getUniformLocation(prog, 'u_bass');
  const uMid  = gl.getUniformLocation(prog, 'u_mid');
  const uHigh = gl.getUniformLocation(prog, 'u_high');

  const fqCtx = fqCanvas.getContext('2d');

  // ── Resize ────────────────────────────────────────────────
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    glCanvas.width  = innerWidth  * dpr;
    glCanvas.height = innerHeight * dpr;
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    fqCanvas.width  = innerWidth  * dpr;
    fqCanvas.height = 120 * dpr;
  }
  resize();
  addEventListener('resize', resize);

  // ── Audio analyser — created ONCE, reuses audio-engine ───
  let analyser = null, dataArray = null, bufLen = 0;
  let audioCtxCreated = false;
  let sB = 0, sM = 0, sH = 0;

  function ensureAnalyser() {
    if (audioCtxCreated) return;
    try {
      const ctx = new (AudioContext || webkitAudioContext)();
      // Connect to the EXISTING audio element — no new Audio() created
      const src = ctx.createMediaElementSource(audio);
      analyser  = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.80;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      bufLen    = analyser.frequencyBinCount;
      dataArray = new Uint8Array(bufLen);
      audioCtxCreated = true;
    } catch(e) {
      console.warn('[Viz] analyser failed:', e);
    }
  }

  function readBands() {
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);
    const be = Math.floor(bufLen * 0.05);
    const me = Math.floor(bufLen * 0.30);
    let bs=0, ms=0, hs=0;
    for (let i=0;  i<be;     i++) bs += dataArray[i];
    for (let i=be; i<me;     i++) ms += dataArray[i];
    for (let i=me; i<bufLen; i++) hs += dataArray[i];
    const k = 0.13;
    sB += k*((bs/be)/255           - sB);
    sM += k*((ms/(me-be))/255      - sM);
    sH += k*((hs/(bufLen-me))/255  - sH);
  }

  // ── Frequency bars ────────────────────────────────────────
  function drawBars() {
    const W = fqCanvas.width, H = fqCanvas.height;
    fqCtx.clearRect(0, 0, W, H);
    if (!analyser) return;
    const bars = 160, bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const t   = i / bars;
      const bin = Math.min(Math.floor(Math.pow(t,1.75)*bufLen*0.65), bufLen-1);
      const val = dataArray[bin] / 255;
      const bh  = val * H * 0.92;
      let r, g, b;
      if (t < 0.5) {
        const f=t*2; r=Math.round(200-f*120); g=Math.round(100+f*110); b=Math.round(80+f*130);
      } else {
        const f=(t-0.5)*2; r=Math.round(80+f*100); g=Math.round(210-f*100); b=Math.round(210+f*45);
      }
      const grad = fqCtx.createLinearGradient(0,H,0,H-bh);
      grad.addColorStop(0, `rgba(${r},${g},${b},${0.5+val*0.5})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      fqCtx.fillStyle = grad;
      fqCtx.fillRect(i*bw+1, H-bh, bw-2, bh);
    }
  }

  // ── Render loop ───────────────────────────────────────────
  let rafId = null, t0 = null, vizOpen = false;

  function frame(ts) {
    if (!vizOpen) { rafId = null; return; }   // stop loop when closed
    rafId = requestAnimationFrame(frame);
    if (!t0) t0 = ts;
    const t = (ts - t0) / 1000;
    readBands();
    drawBars();
    gl.uniform2f(uRes,  glCanvas.width, glCanvas.height);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uBass, sB);
    gl.uniform1f(uMid,  sM);
    gl.uniform1f(uHigh, sH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ── Open / close ──────────────────────────────────────────
  function vizOpen_() {
    if (!state.currentTrack) { showToast('Play a track first'); return; }
    ensureAnalyser();                          // safe to call multiple times
    vizUpdateTrackInfo(state.currentTrack);
    overlay.classList.remove('viz-hidden');
    vizOpen = true;
    t0 = null;                                 // reset clock so smoke starts fresh
    if (!rafId) rafId = requestAnimationFrame(frame);
    vizBtn && vizBtn.classList.add('active');

    // auto-hide pill after 4 s
    npPill && npPill.classList.remove('viz-pill-hide');
    setTimeout(() => npPill && npPill.classList.add('viz-pill-hide'), 4000);
  }

  function vizClose() {
    vizOpen = false;
    overlay.classList.add('viz-hidden');
    vizBtn && vizBtn.classList.remove('active');
  }

  // expose close so Escape key works
  window.vizClose = vizClose;

  vizBtn  && vizBtn.addEventListener('click', vizOpen_);
  backBtn && backBtn.addEventListener('click', vizClose);
  npPill  && npPill.addEventListener('click', () => npPill.classList.toggle('viz-pill-hide'));

  // ── Public: update now-playing pill ──────────────────────
  window.vizUpdateTrackInfo = function(track) {
    if (!track) return;
    npTitle && (npTitle.textContent = track.title || '—');
    npAlbum && (npAlbum.textContent = track.albumName || 'SoundVault');
    // re-show pill briefly on track change
    if (vizOpen && npPill) {
      npPill.classList.remove('viz-pill-hide');
      clearTimeout(npPill._hideTimer);
      npPill._hideTimer = setTimeout(() => npPill.classList.add('viz-pill-hide'), 4000);
    }
  };
}

// stub so playCurrentQueueItem() can call it before setupVisualizer() runs
function vizUpdateTrackInfo(track) {
  if (window.vizUpdateTrackInfo) window.vizUpdateTrackInfo(track);
}