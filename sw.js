// Offline support: keeps the app itself available without a connection.
// Notes live in IndexedDB (see js/db.js); this only caches the app files.
const VERSION = 'flint-2';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'fonts/fonts.css',
  'js/app.js',
  'js/auth.js',
  'js/db.js',
  'js/graph.js',
  'js/markdown.js',
  'js/merge.js',
  'js/sync.js',
  'js/scripture.js',
  'js/highlight.js',
  'vendor/marked.min.js',
  'vendor/purify.min.js',
  'icons/flint-mark.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'fonts/literata-latin-wght-normal.woff2',
  'fonts/literata-latin-wght-italic.woff2',
  'fonts/source-serif-4-latin-wght-normal.woff2',
  'fonts/source-serif-4-latin-wght-italic.woff2',
  'fonts/eb-garamond-latin-wght-normal.woff2',
  'fonts/eb-garamond-latin-wght-italic.woff2',
  'fonts/merriweather-latin-wght-normal.woff2',
  'fonts/merriweather-latin-wght-italic.woff2',
  'fonts/bitter-latin-wght-normal.woff2',
  'fonts/bitter-latin-wght-italic.woff2',
  'fonts/libre-baskerville-latin-400-normal.woff2',
  'fonts/libre-baskerville-latin-700-normal.woff2',
  'fonts/libre-baskerville-latin-400-italic.woff2',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-400-italic.woff2',
  'fonts/opendyslexic-latin-400-normal.woff2',
  'fonts/opendyslexic-latin-700-normal.woff2',
  'fonts/opendyslexic-latin-400-italic.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return; // OneDrive and sign-in always go to the network

  // App pages: network first so updates arrive, cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put('index.html', copy));
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  // Other app files: serve from cache, refresh in the background.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
