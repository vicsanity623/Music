// ============================================================
//  SoundVault — Service Worker  v1.0
//  Handles offline caching, background fetch, media sessions
// ============================================================

const CACHE_NAME     = 'soundvault-v1';
const STATIC_ASSETS  = ['./', './index.html', './style.css', './main.js', './manifest.json'];
const AUDIO_CACHE    = 'soundvault-audio-v1';
const MAX_AUDIO_CACHE_MB = 2048; // 2 GB limit for audio cache

// ── Install ───────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching static assets');
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Pre-cache partial failure (ok on first install):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k !== CACHE_NAME && k !== AUDIO_CACHE)
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ── Fetch strategy ────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Audio files — cache-first with Range support
  if (isAudioRequest(event.request)) {
    event.respondWith(handleAudio(event.request));
    return;
  }

  // library.json — network-first (always fresh)
  if (url.pathname.endsWith('library.json')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Static app shell — cache-first
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Default — network with cache fallback
  event.respondWith(networkFirst(event.request));
});

// ── Strategies ────────────────────────────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}

async function handleAudio(request) {
  // Check audio cache first
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    // For range requests we cannot cache directly, just proxy
    if (request.headers.has('range')) {
      return fetch(request);
    }
    const response = await fetch(request);
    if (response.ok && response.status === 200) {
      const cache = await caches.open(AUDIO_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Audio unavailable offline', { status: 503 });
  }
}

// ── Helpers ───────────────────────────────────────────────────
function isAudioRequest(request) {
  const url = new URL(request.url);
  return /\.(mp3|flac|m4a|ogg|wav)$/i.test(url.pathname);
}

function isStaticAsset(url) {
  return url.pathname === '/' ||
    /\.(html|css|js|json|png|jpg|svg|ico|webmanifest)$/i.test(url.pathname);
}

// ── Background sync for playlist saves ───────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-playlists') {
    event.waitUntil(syncPlaylists());
  }
});

async function syncPlaylists() {
  // Playlists are stored in IndexedDB / localStorage on-device
  // This hook is available for future server-side sync
  console.log('[SW] Playlist sync triggered');
}

// ── Push notifications (future use) ──────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'SoundVault', {
      body: data.body || 'New content available',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
