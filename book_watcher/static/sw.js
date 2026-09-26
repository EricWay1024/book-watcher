// Service worker: makes Book Watcher installable and quick to open.
// - Page loads: network first (so deploys show up at once), cached copy when offline.
// - /static/* files: cache first. Their URLs carry a content hash (?v=…), so they never go stale.
// - /api/*, login and speech: never cached.
const CACHE = 'book-watcher-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
      return r; // a redirect to /login passes straight through
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }

  if (url.pathname.startsWith('/static/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(async r => {
      if (r.ok) {
        const c = await caches.open(CACHE);
        // drop older versions of the same file before storing this one
        for (const old of await c.keys()) if (new URL(old.url).pathname === url.pathname) await c.delete(old);
        await c.put(req, r.clone());
      }
      return r;
    })));
  }
});
