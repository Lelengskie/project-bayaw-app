// Offline support. Pages: network first (always fresh when online). Site files and the question bank:
// served from cache, refreshed in the background. Supabase (login, chat, rankings) is never touched.
const CACHE = 'bayaw-v1';
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png'];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Keep one copy per file: drop older ?v= versions when a new one is stored
async function put(cache, req, res) {
  const path = new URL(req.url).pathname;
  for (const old of await cache.keys()) {
    if (old.url !== req.url && new URL(old.url).pathname === path && new URL(old.url).origin === self.location.origin) await cache.delete(old);
  }
  await cache.put(req, res);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN.test(req.url)) return; // Supabase and everything else: straight to network

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      // only the app page is the offline shell; other pages (like /about/) must not replace it
      if (url.pathname === new URL('./', self.location).pathname) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); }
      return res;
    }).catch(() => caches.match('./')));
    return;
  }

  // Stale-while-revalidate for site files, the question bank, images and CDN libraries
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req);
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') put(cache, req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
