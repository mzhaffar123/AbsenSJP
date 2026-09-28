// ──────────────────────────────────────────────────
//  AbsenSJP — Service Worker
//  Strategi: Cache-first untuk aset statis,
//            Network-first untuk API (/api/*)
// ──────────────────────────────────────────────────

const CACHE_NAME = 'absenmuka-v1';

// Aset statis yang di-cache saat install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/login.html',
  '/register.html',
  '/jadwal.html',
  '/laporan.html',
  '/settings.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logosjp.jpeg',
];

// ── Install: cache semua aset statis ────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// ── Activate: hapus cache lama ──────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: strategi berdasarkan jenis request ───────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Lewati request non-GET dan request ke CDN eksternal (face-api.js, fonts)
  if (request.method !== 'GET') return;
  if (!url.origin.includes(self.location.origin)) return;

  // API calls → Network-first (data harus selalu segar)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Aset statis → Cache-first (cepat, offline-friendly)
  event.respondWith(cacheFirst(request));
});

// ── Cache-first strategy ─────────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback: kembalikan halaman utama
    const fallback = await caches.match('/');
    return fallback || new Response('Offline — buka aplikasi saat terkoneksi internet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// ── Network-first strategy ───────────────────────────
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
    return cached || new Response(JSON.stringify({ error: 'Tidak ada koneksi internet' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
