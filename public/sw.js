// Kadima service worker: app shell + timetable data offline, everything live stays network-only.
const SHELL = 'kadima-shell-v1';
const DATA = 'kadima-data-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', 'manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const path = url.pathname;
  if (path.endsWith('/data/meta.json')) return; // always fresh
  if (path.includes('/data/')) {
    // versioned (?v=build): cache-first, and drop older versions of the same file
    e.respondWith(caches.open(DATA).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) {
        const keys = await c.keys();
        for (const k of keys) {
          const ku = new URL(k.url);
          if (ku.pathname === path && ku.search !== url.search) c.delete(k);
          if (ku.pathname.includes('/days/') && path.includes('/days/') && ku.search !== url.search) c.delete(k);
        }
        c.put(e.request, res.clone());
      }
      return res;
    }));
    return;
  }
  if (path.includes('/assets/')) {
    e.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // navigation & other files: network first, fallback to cache
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('./'))));
});
