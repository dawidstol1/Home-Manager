'use strict';

// Service worker: interfejs działa offline, a ostatnio pobrane dane API
// są dostępne do podglądu bez połączenia (tylko odczyt).
const VERSION = 'v7';
const SHELL_CACHE = `shell-${VERSION}`;
const API_CACHE = `api-${VERSION}`;
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/scanner.js', '/vendor/zxing.min.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
  '/fonts/inter-latin-wght-normal.woff2', '/fonts/inter-latin-ext-wght-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-wght-normal.woff2', '/fonts/plus-jakarta-sans-latin-ext-wght-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL_CACHE, API_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || req.method !== 'GET') return;

  // Konta i pliki dokumentów zawsze z sieci – bez zapisywania na urządzeniu.
  if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/documents/')) return;

  if (url.pathname.startsWith('/api/')) {
    // Network-first: świeże dane, a w razie braku sieci – ostatnia kopia.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            // Klon musi powstać od razu – zanim strona odczyta treść odpowiedzi.
            const copy = res.clone();
            e.waitUntil(caches.open(API_CACHE).then((c) => c.put(req, copy)));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || new Response(
          JSON.stringify({ error: 'Brak połączenia z serwerem' }),
          { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        )))
    );
    return;
  }

  // Stale-while-revalidate dla plików interfejsu.
  e.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === 'navigate' ? await cache.match('/') : undefined);
      const network = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
