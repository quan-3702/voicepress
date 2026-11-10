const CACHE = 'voicepress-v3';
const LIB = 'voicepress-lib'; // AI voice engine files from the CDN, kept for offline use
const ASSETS = ['./', 'index.html', 'help.html', 'privacy.html', 'style.css', 'app.js', 'tts-worker.js', 'lame.min.js', 'pdf.min.mjs', 'pdf.worker.min.mjs', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== LIB && k !== 'voicepress-voices' && k.startsWith('voicepress-')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(LIB).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }))));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
