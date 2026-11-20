'use strict';

// Service worker: interfejs działa offline, a ostatnio pobrane dane API
// są dostępne do podglądu bez połączenia (tylko odczyt).
const VERSION = 'v8';
const SHELL_CACHE = `shell-${VERSION}`;
const API_CACHE = `api-${VERSION}`;
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/scanner.js', '/vendor/zxing.min.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
  '/fonts/inter-latin-wght-normal.woff2', '/fonts/inter-latin-ext-wght-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-wght-normal.woff2', '/fonts/plus-jakarta-sans-latin-ext-wght-normal.woff2',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' – pliki prosto z serwera, z pominięciem pamięci podręcznej przeglądarki.
  e.waitUntil(caches.open(SHELL_CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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

  // Pliki interfejsu: najpierw serwer (zawsze najnowsza wersja), bez sieci – kopia z urządzenia.
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })
      .catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(req, { ignoreSearch: true }))
          || (req.mode === 'navigate' ? await cache.match('/') : undefined)
          || new Response('Brak połączenia', { status: 503 });
      })
  );
});
