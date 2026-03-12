const CACHE = 'agroirri-v2-cache';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.png'
];
 
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});
 
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
 
self.addEventListener('fetch', e => {
  // Toujours aller chercher l'API météo sur le réseau
  if (e.request.url.includes('open-meteo.com')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // Pour le reste : cache d'abord, réseau en fallback
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});