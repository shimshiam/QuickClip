// QuickClip Service Worker v3
const CACHE_NAME = 'quickclip-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/delivery.js',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key.startsWith('quickclip-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch — network-first for app shell, skip API routes entirely
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Never cache API requests — they must always be live from the server
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !APP_SHELL.includes(url.pathname) || url.search) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
