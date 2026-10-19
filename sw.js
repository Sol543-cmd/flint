// Offline support: keeps the app itself available without a connection.
// Notes live in IndexedDB (see js/db.js); this only caches the app files.
const VERSION = 'flint-18';
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
  'js/cite.js',
  'js/flintdata.js',
  'js/listen.js',
  'js/docxexport.js',
  'vendor/docx.min.js',
  'vendor/markdown-it.min.js',
  'vendor/markdown-it-footnote.min.js',
  'js/bible.js',
  'js/books.js',
  'vendor/jszip.min.js',
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

// Books shared to Flint from another app (Android's Share menu) arrive here.
async function receiveShare(req) {
  const form = await req.formData();
  const files = form.getAll('file').filter((f) => f && f.name);
  const dbh = await new Promise((res, rej) => { const r = indexedDB.open('flint-share', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  for (const f of files) {
    const buf = await f.arrayBuffer();
    await new Promise((res) => { const t = dbh.transaction('files', 'readwrite'); t.objectStore('files').put({ name: f.name, type: f.type, buf }, `${Date.now()}-${f.name}`); t.oncomplete = res; t.onerror = res; });
  }
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return; // OneDrive and sign-in always go to the network

  // Your settings file: always try the network first, so a new app ID takes effect right away.
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
    return;
  }
  // App pages: network first so updates arrive, cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put('index.html', copy));
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  // Large files that never change (Bibles, fonts, libraries, icons): cache first.
  if (/\/(bible|fonts|vendor|icons)\//.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // Flint's own code and styles: always the newest from the network, so the page and its
  // code never come from different versions; the saved copy is used only when offline.
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
