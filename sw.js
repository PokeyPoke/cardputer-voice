// Service Worker – caches app shell for offline use.
// Transformers.js caches the Whisper model in IndexedDB automatically.

const CACHE_NAME = 'cardputer-voice-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './worker.js',
  './manifest.json',
];

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: drop old caches ─────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network ─────────────────────────────
self.addEventListener('fetch', (event) => {
  // Pass through requests for CDN resources (Transformers.js, model weights)
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
