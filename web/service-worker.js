// The server fills in BUILD when it serves this file: `shell` lists every web/ and
// lib/ asset, and `version` changes whenever any of them does. Do not edit by hand.
const BUILD = { version: 'dev', shell: ['/'] };
const CACHE = `2core-shell-${BUILD.version}`;
const SHELL = BUILD.shell;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

// The app is a live controller, so always prefer the network. The cached shell
// is only a launch fallback; API calls are never cached.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin || new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match('/'))));
});
