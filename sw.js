/* Ledger service worker — offline app shell only.
 *
 * Deliberately conservative: it caches the static shell and nothing else.
 * Supabase API/auth traffic is cross-origin and is never touched here, so a
 * stale cache can never serve you someone else's data or an outdated balance.
 * Transaction data always comes from the network via the Supabase client.
 */

const CACHE = 'ledger-shell-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll() rejects the whole batch if any single entry 404s, which would
      // leave the worker uninstalled. Add entries individually instead.
      .then(cache => Promise.all(
        SHELL.map(url => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Only same-origin GETs are eligible. Everything else — Supabase REST and
  // auth calls, the CDN libraries, any POST/PATCH/DELETE — goes straight to
  // the network untouched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first so a redeployed HTML file is picked up immediately; the
  // cache is only a fallback for genuinely offline use.
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
