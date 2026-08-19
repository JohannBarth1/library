// eLibrary service worker.
// Save this file as sw.js in the SAME folder as index.html (e.g. the repo
// root that GitHub Pages serves) — index.html registers it from './sw.js'.
//
// Bump SHELL_CACHE whenever you want to force clients to pick up a fresh
// app shell (jszip, fonts CSS, the cached index.html). Bumping it does NOT
// touch offline EPUBs/covers — those live in caches that start with
// 'elib-epub-cache' / 'elib-cover-cache' and are deliberately preserved
// below regardless of shell version.
const SHELL_CACHE = 'elib-shell-v3';
const SHELL_URLS = [
  self.registration.scope,
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&display=swap'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_URLS)).catch(()=>{}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && !k.startsWith('elib-epub-cache') && !k.startsWith('elib-cover-cache')).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = e.request.url;
  // Never intercept Firebase/Google API calls — auth, Firestore, and Storage
  // must always go straight to the network so the app's own online/offline
  // handling (and the dedicated EPUB cache) stays in control of those.
  if(url.includes('googleapis.com') || url.includes('gstatic.com') || url.includes('firebasestorage.app')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(resp => {
        if(resp && resp.ok && (url.startsWith(self.location.origin) || SHELL_URLS.includes(url))) {
          const copy = resp.clone();
          // Guarantee the write finishes even if the SW would otherwise be
          // suspended right after respondWith() settles. Without this, a
          // large response (e.g. index.html) could get truncated mid-write,
          // and a later load would serve that corrupted cache entry —
          // causing "Unexpected end of input" errors.
          e.waitUntil(
            caches.open(SHELL_CACHE).then(cache => cache.put(e.request, copy)).catch(()=>{})
          );
        }
        return resp;
      }).catch(() => {
        // Network unreachable and nothing cached for this exact request —
        // for a page navigation (e.g. reopening an already-open tab right
        // as the device is reconnecting), fall back to the cached app
        // shell instead of letting the browser show its own "can't load"
        // page. The app's own online/offline handling takes over from there.
        if(cached) return cached;
        if(e.request.mode === 'navigate') return caches.match(self.registration.scope);
        return undefined;
      });
      return cached || networkFetch;
    })
  );
});
